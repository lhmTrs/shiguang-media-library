// UQ03A domain orchestrator only. No default instance, routes, credentials, filesystem or HTTP.
import {identity,sameIdentity,clone,id,uuid,integer,plain,fingerprint,SCHEDULER_LIMITS as L,uploadSafety,uploadResources,retryDeadline,fail} from './cloud-upload-protocol.mjs';
const owners=new WeakMap();
const libraryOwners=new Map();
const terminal=new Set(['COMMITTED','SKIPPED','FAILED','CANCELLED']);
const unresolved=new Set(['REQUESTING','UPLOADING','CHECKING_REUSE','RECONCILING']);
export class CloudUploadScheduler {
    constructor(batches,{remote,clock=()=>Date.now(),timers={setTimeout,clearTimeout},operationMs=L.operationMs,pollMs=L.pollMs,intervalMs=250,dispatchPermit}={}) {
        if(!batches?.store||!batches.upload||!remote||['capabilities','eligibility','resources','request','resolve','transfer'].some(k=>typeof remote[k]!=='function'))fail('INVALID_ADAPTER');
        integer(operationMs,10,L.operationMs);integer(pollMs,1000,300000);integer(intervalMs,10,30000);
        if(typeof clock!=='function'||typeof timers.setTimeout!=='function'||typeof timers.clearTimeout!=='function')fail('INVALID_ADAPTER');
        if(dispatchPermit!==undefined&&(!dispatchPermit||['enter','check','leave'].some(k=>typeof dispatchPermit[k]!=='function')))fail('INVALID_ADAPTER');
        this.dispatchPermit=dispatchPermit;this.dispatchLease=null;this.dispatchFailure=null;
        this.batches=batches;this.upload=batches.upload;this.remote=remote;this.clock=clock;this.timers=timers;
        this.operationMs=operationMs;this.pollMs=pollMs;this.intervalMs=intervalMs;
        this.started=false;this.closing=false;this.closed=false;this.automatic=false;this.alarm=null;this.deadline=null;this.inflight=null;this.controller=null;this.batchAfter=null;this.captured=null;this.lastExit=null;
    }
    now(){return integer(this.clock());}
    state(){return{started:this.started,closing:this.closing,closed:this.closed,inflight:this.inflight?1:0,timers:(this.alarm!==null?1:0)+(this.deadline!==null?1:0)};}
    start({recover=true,automatic=true}={}) {
        if(this.closing||this.closed)fail('SCHEDULER_CLOSED');
        if(this.started)return this.state();
        if(typeof automatic!=='boolean'||typeof recover!=='boolean')fail('INVALID_REQUEST');
        if(owners.has(this.batches.store.db)||owners.has(this.upload))fail('SCHEDULER_ACTIVE');
        this.captured=identity(this.batches.currentIdentity());this.batches.guard(this.captured);
        if(libraryOwners.has(this.captured.librarySourceId))fail('SCHEDULER_ACTIVE');
        if(libraryOwners.size>=32)fail('LOCAL_SCHEDULER_LIMIT');
        libraryOwners.set(this.captured.librarySourceId,this);
        owners.set(this.batches.store.db,this);owners.set(this.upload,this);
        try{if(recover)this.batches.recover(this.captured);this.started=true;this.automatic=automatic;if(automatic)this.arm();return this.state();}
        catch(error){this.release();throw error;}
    }
    release(){if(this.dispatchLease)return false;for(const key of [this.batches.store.db,this.upload])if(owners.get(key)===this)owners.delete(key);if(this.captured&&libraryOwners.get(this.captured.librarySourceId)===this)libraryOwners.delete(this.captured.librarySourceId);}
    dispatchState(){const x=this.dispatchLease;return{configured:!!this.dispatchPermit,acquiring:x?.acquiring===true,held:!!x&&x.token!==null,releasing:x?.releasing===true,unknown:x?.unknown===true,settled:x===null};}
    async enterDispatch(who){
        if(!this.dispatchPermit)return true;
        this.assertIdentity(who);if(this.closing)fail('SCHEDULER_CLOSING');
        const lease={token:null,acquiring:true,releasing:false,unknown:false};this.dispatchLease=lease;
        let result;try{result=await this.dispatchPermit.enter(clone(who),{signal:this.controller.signal});}catch(error){lease.acquiring=false;lease.unknown=true;throw error;}
        lease.acquiring=false;
        if(result?.permit!==undefined&&result.permit!==null)lease.token=result.permit;
        if(result?.unknown===true||result?.closed===false){lease.unknown=true;fail('DISPATCH_PERMIT_UNKNOWN',503);}
        if(result?.allowed===false&&result.permit===null){this.dispatchLease=null;this.assertIdentity(who);if(this.closing||this.controller.signal.aborted)fail('SCHEDULER_CLOSING');return false;}
        if(result?.allowed!==true||lease.token===null){lease.unknown=true;fail('DISPATCH_PERMIT_UNKNOWN',503);}
        this.assertIdentity(who);if(this.closing||this.controller.signal.aborted)fail('SCHEDULER_CLOSING');
        return true;
    }
    async checkDispatch(who){
        if(!this.dispatchPermit)return;
        this.assertIdentity(who);if(this.closing||this.controller?.signal.aborted)fail('SCHEDULER_CLOSING');
        const lease=this.dispatchLease;if(!lease||lease.token===null||lease.unknown)fail('DISPATCH_PERMIT_UNKNOWN',503);
        const result=await this.dispatchPermit.check(clone(who),lease.token,{signal:this.controller.signal});
        // Persist explicit uncertainty before any identity/closing rejection can mask the awaited fact.
        if(result?.unknown===true||result?.closed===false)lease.unknown=true;
        this.assertIdentity(who);if(this.closing||this.controller?.signal.aborted)fail('SCHEDULER_CLOSING');
        if(lease.unknown)fail('DISPATCH_PERMIT_UNKNOWN',503);
        if(result?.allowed!==true)fail('MAINTENANCE_BUSY',423);
    }
    async leaveDispatch(who){
        const lease=this.dispatchLease;if(!lease)return;
        if(lease.token===null||lease.unknown){this.closing=true;this.started=false;this.automatic=false;if(this.alarm!==null)this.timers.clearTimeout(this.alarm);this.alarm=null;return;}
        lease.releasing=true;
        try{const result=await this.dispatchPermit.leave(clone(who),lease.token,{settled:true});
            if(result?.released===true&&result.settled===true&&result.unknown!==true&&result.closed!==false)this.dispatchLease=null;
            else lease.unknown=true;
        }catch{lease.unknown=true;}finally{lease.releasing=false;}
        if(this.dispatchLease){this.closing=true;this.started=false;this.automatic=false;if(this.alarm!==null)this.timers.clearTimeout(this.alarm);this.alarm=null;}
    }
    arm(){if(!this.started||this.closing||!this.automatic||this.alarm!==null)return;this.alarm=this.timers.setTimeout(()=>{this.alarm=null;this.tick().catch(()=>{}).finally(()=>this.arm());},this.intervalMs);}
    assertIdentity(who){let current;try{current=identity(this.batches.currentIdentity());}catch{fail('AUTH_CHANGED');}if(!sameIdentity(who,current))fail('AUTH_CHANGED');}
    context(who,itemId,dispatch=false){this.assertIdentity(who);return this.batches.schedulerContext(who,itemId,{dispatch});}
    async call(kind,who,context,fn){
        this.assertIdentity(who);if(this.closing)fail('SCHEDULER_CLOSING');
        if(this.dispatchPermit)await this.checkDispatch(who);
        const operationId=uuid();let result;
        this.deadline=this.timers.setTimeout(()=>this.controller?.abort('operation-deadline'),this.operationMs);
        try{result=await fn(this.controller.signal);this.lastExit={operationId,kind,settledAt:this.now(),itemId:context.item.itemId,localAttemptId:context.attempt?.attemptId??null,clientRequestId:context.item.clientRequestId??null,identityFingerprint:fingerprint(who)};
            if(this.dispatchPermit)try{await this.checkDispatch(who);}catch(error){
                // Preserve original late authoritative receipt settlement; never dispatch again under a failed check.
                if(['transfer','reuse','resolve','cancel'].includes(kind)&&(result?.commitState==='COMMITTED'||result?.outcome==='COMMITTED'))this.dispatchFailure=error;else throw error;
            }
            return result;}
        finally{if(this.deadline!==null)this.timers.clearTimeout(this.deadline);this.deadline=null;}
    }
    checkVersion(who,context,dispatch=false){
        const current=this.context(who,context.item.itemId,dispatch);
        if(current.item.version!==context.item.version||current.batch.version!==context.batch.version||current.item.currentAttemptId!==context.item.currentAttemptId)fail('VERSION_CONFLICT');
        if(this.closing||this.controller?.signal.aborted)fail('OPERATION_ABORTED');
        return current;
    }
    async safety(who,context){
        const capabilities=await this.call('capabilities',who,context,signal=>this.remote.capabilities(clone(who),{signal}));
        this.checkVersion(who,context,true);const optional=uploadSafety(capabilities,context.item);
        const eligibility=await this.call('eligibility',who,context,signal=>this.remote.eligibility(clone(who),clone(context),{signal}));
        this.checkVersion(who,context,true);
        if(!plain(eligibility)||!['NEW','IN_PROGRESS'].includes(eligibility.classification)||typeof eligibility.reviewRequired!=='boolean')fail('NEEDS_RECONCILIATION');
        return{...optional,reviewRequired:eligibility.reviewRequired};
    }
    async resources(who,context){
        const raw=await this.call('resources',who,context,signal=>this.remote.resources(clone(who),{signal}));
        this.checkVersion(who,context,true);return uploadResources(raw);
    }
    async verifyIntent(who,context){
        const a=context.attempt,r=context.item;if(!a)fail('STORE_INVALID');
        await this.call('verify-intent',who,context,()=>this.upload.prepareWithIdentity({intentId:a.intentId,clientRequestId:a.clientRequestId},r.sourceVersion,{assetId:r.representativeAssetId,sha256:r.sha256,...r.metadata}));
        this.checkVersion(who,context,true);
        if(typeof this.upload.bindSettledContext==='function'){
            await this.call('bind-intent',who,context,()=>this.upload.bindSettledContext({intentId:a.intentId,clientRequestId:a.clientRequestId},{identity:clone(who),batchId:r.batchId,itemId:r.itemId,localAttemptId:a.attemptId,metadataFingerprint:r.metadataFingerprint}));
            this.checkVersion(who,context,true);
        }
    }
    async record(who,context,receipt){
        // A completed original call may return after dispose or an identity change.
        const result=await this.batches.recordReceipt(who,context.item.itemId,context.attempt.attemptId,receipt);
        if(result.cleanupPending){
            try{this.assertIdentity(who);}catch{return result;}
            this.defer(who,this.context(who,context.item.itemId),{code:'CLEANUP_PENDING'});
        }
        return result;
    }
    async resolution(who,context,result,exit){
        if(!plain(result)||result.clientRequestId!==context.item.clientRequestId||!['COMMITTED','NOT_COMMITTED','UNKNOWN'].includes(result.commitState))fail('INVALID_REMOTE_STATE');
        if(result.commitState==='COMMITTED')return this.record(who,context,result.receipt);
        this.assertIdentity(who);
        let current=this.context(who,context.item.itemId);
        if(current.item.currentAttemptId!==context.attempt.attemptId)fail('STALE_ATTEMPT');
        if(result.commitState==='NOT_COMMITTED'&&result.termination){
            return this.batches.schedulerTerminate(who,current,result.termination,exit);
        }
        if(result.commitState==='NOT_COMMITTED'&&result.request){
            current=this.batches.schedulerObserve(who,current.item.itemId,current.attempt.attemptId,result.request,this.now()+this.pollMs);
            if(current.item.state==='WAITING_APPROVAL')await this.releasePending(who,current);
            return current;
        }
        return this.defer(who,current,{code:'REMOTE_UNKNOWN'},true);
    }
    async releasePending(who,context){
        if(typeof this.upload.releasePayloadForApproval!=='function')fail('ADAPTER_UPDATE_REQUIRED');
        await this.call('release-pending',who,context,()=>this.upload.releasePayloadForApproval(context.item.intentId));
        this.assertIdentity(who);
    }
    defer(who,context,error,increment=true){
        this.assertIdentity(who);const current=this.context(who,context.item.itemId);
        if(current.item.receipt&&!current.item.cleanupPending)return current;
        if(!current.item.receipt&&terminal.has(current.item.state)&&!(current.item.state==='FAILED'&&(current.item.cleanupPending||current.item.resourcesRetained)))return current;
        const previous=current.item.retryCount??0,attempts=Math.min(L.retries,previous+(increment?1:0));
        const rawCode=error?.status===403?'FORBIDDEN':error?.code||'REMOTE_UNAVAILABLE',code=/^[A-Z][A-Z0-9_]{0,63}$/.test(rawCode)?rawCode:'REMOTE_UNAVAILABLE';
        let next,blocked=attempts>=L.retries;
        try{next=Number.isSafeInteger(error?.retryAt)?integer(error.retryAt):retryDeadline(error?.retryAfter,this.now(),attempts);}
        catch{next=null;blocked=true;}
        const uncertain=!!current.item.currentAttemptId;
        const permanent=['SOURCE_CHANGED','REPRESENTATIVE_STALE','RETRY_CLAIM_REQUIRED','REMOTE_MAPPING_CONFLICT','STALE_ATTEMPT','RECEIPT_INVALID','RECEIPT_CONFLICT','ADMISSION_CHANGED','FORBIDDEN','FILE_IDENTITY_CONFLICT','CONTENT_MISMATCH','INTEGRITY_UNAVAILABLE','UPLOAD_REVIEW_REQUIRED','BACKFILL_REQUIRED','STALE_REMOTE_STATE'].includes(code);
        return this.batches.schedulerUpdate(who,current,{...(current.item.receipt||terminal.has(current.item.state)?{}:{state:permanent?'NEEDS_CONFIRMATION':uncertain?'RECONCILING':'RETRY_WAIT'}),retryCount:attempts,nextRetryAt:blocked||permanent?null:next,lastCode:code,schedulerBlocked:blocked||permanent});
    }
    eligible(batch,row){
        if(row.schedulerBlocked||(row.nextRetryAt!==null&&row.nextRetryAt!==undefined&&row.nextRetryAt>this.now()))return false;
        if(row.receipt)return row.cleanupPending===true;
        if(row.state==='FAILED'&&(row.cleanupPending||row.resourcesRetained))return true;
        if(terminal.has(row.state)||row.state==='NEEDS_CONFIRMATION')return false;
        if(batch.stopRequested)return !!row.currentAttemptId;
        if(batch.state==='PAUSED')return row.state==='RECONCILING'&&!!row.currentAttemptId;
        return true;
    }
    async choose(who){
        let wrapped=false;
        for(let i=0;i<L.scanBatches;i++){
            let page=this.batches.schedulerBatches(who,this.batchAfter);
            if(!page.length){if(wrapped||this.batchAfter===null)return null;this.batchAfter=null;wrapped=true;page=this.batches.schedulerBatches(who,null);if(!page.length)return null;}
            const batch=page[0];this.batchAfter=batch.batchId;
            if(!sameIdentity(batch,who,false))continue;
            const scanned=this.batches.schedulerItems(who,batch.batchId);
            const item=scanned.items.find(r=>this.eligible(scanned.batch,r));
            if(item)return this.context(who,item.itemId);
        }
        return {scanProgress:true};
    }
    async step(who,initial){
        let c=initial,r=c.item;
        if(r.receipt){
            // Mutable availability is an observation; reconstruct only the caller DTO decoration.
            return this.record(who,c,{...r.receipt,currentAvailability:r.currentAvailability?.state??r.receipt.currentAvailability??'UNKNOWN'});
        }
        if(r.state==='FAILED'&&(r.cleanupPending||r.resourcesRetained)){
            const result=await this.batches.cleanupSettled(who,r.itemId,c.attempt.attemptId);
            this.assertIdentity(who);
            return result.cleanupPending?this.defer(who,this.context(who,r.itemId),{code:result.code||'CLEANUP_PENDING'}):result;
        }
        if(c.batch.stopRequested){
            if(typeof this.remote.cancel!=='function')return this.defer(who,c,{code:'CANCEL_UNAVAILABLE'});
            c=this.batches.schedulerUpdate(who,c,{state:'RECONCILING',lastCode:null});
            const result=await this.call('cancel',who,c,signal=>this.remote.cancel(clone(who),clone(c),{signal}));
            return this.resolution(who,c,result,this.lastExit);
        }
        if(unresolved.has(r.state)){
            const result=await this.call('resolve',who,c,signal=>this.remote.resolve(clone(who),clone(c),{signal}));
            return this.resolution(who,c,result,this.lastExit);
        }
        if(r.state==='WAITING_APPROVAL'){
            const result=await this.call('resolve',who,c,signal=>this.remote.resolve(clone(who),clone(c),{signal}));
            return this.resolution(who,c,result,this.lastExit);
        }
        if(c.batch.state==='PAUSED')return null;
        const safety=await this.safety(who,c);
        const capacity=await this.resources(who,c);
        if(!r.currentAttemptId||!r.intentPrepared){
            if(!r.intentId&&capacity.activeIntents>=L.intents)fail('LOCAL_INTENT_LIMIT');
            if(capacity.intentBytes>=L.intentBytes)fail('LOCAL_INTENT_LIMIT');
            if(safety.reviewRequired&&this.batches.schedulerPending(who)>=L.pending)fail('PENDING_WINDOW_FULL');
            await this.safety(who,c);this.checkVersion(who,c,true);
            await this.call('prepare',who,c,()=>this.batches.prepareItem(who,r.itemId,{expectedBatchVersion:c.batch.version}));
            c=this.context(who,r.itemId);return this.batches.schedulerUpdate(who,c,{intentPrepared:true},{dispatch:true});
        }
        if(r.state==='HASHED'||r.state==='RETRY_WAIT'){
            if(safety.reviewRequired&&this.batches.schedulerPending(who)>=L.pending)fail('PENDING_WINDOW_FULL');
            await this.verifyIntent(who,c);const requestSafety=await this.safety(who,c);
            if(requestSafety.reviewRequired&&this.batches.schedulerPending(who)>=L.pending)fail('PENDING_WINDOW_FULL');
            c=this.batches.schedulerRequest(who,c,this.now(),requestSafety.reviewRequired);
            const observed=await this.call('request',who,c,signal=>this.remote.request(clone(who),clone(c),{signal}));
            this.assertIdentity(who);c=this.batches.schedulerObserve(who,r.itemId,c.attempt.attemptId,observed,this.now()+this.pollMs);
            if(c.item.state==='WAITING_APPROVAL')await this.releasePending(who,c);
            return c;
        }
        if(r.state==='READY'){
            await this.verifyIntent(who,c);const verifiedSafety=await this.safety(who,c);
            if(verifiedSafety.reuse&&r.reuseDecision!=='NEEDS_UPLOAD'){
                if(typeof this.remote.reuse!=='function')fail('REUSE_UNAVAILABLE');
                c=this.batches.schedulerUpdate(who,c,{state:'CHECKING_REUSE'},{dispatch:true});
                const reused=await this.call('reuse',who,c,signal=>this.remote.reuse(clone(who),clone(c),{signal}));
                if(reused?.outcome==='COMMITTED')return this.record(who,c,reused.receipt);
                this.assertIdentity(who);
                if(reused?.outcome!=='NEEDS_UPLOAD')fail('REUSE_UNKNOWN');
                c=this.context(who,r.itemId);return this.batches.schedulerUpdate(who,c,{state:'READY',reuseDecision:'NEEDS_UPLOAD'},{dispatch:true});
            }
            if(capacity.snapshotBytes+r.declaredBytes>L.snapshotBytes)fail('LOCAL_SNAPSHOT_LIMIT');
            if(typeof this.upload.rebuildPayload!=='function')fail('ADAPTER_UPDATE_REQUIRED');
            await this.call('rebuild',who,c,()=>this.upload.rebuildPayload(r.intentId));
            this.checkVersion(who,c,true);
            // Re-read all mandatory gates after potentially lengthy source hashing/snapshot preparation.
            await this.safety(who,c);await this.resources(who,c);
            c=this.batches.schedulerUpdate(who,c,{state:'UPLOADING',lastCode:null},{dispatch:true});
            const committed=await this.call('transfer',who,c,signal=>this.remote.transfer(clone(who),clone(c),{signal}));
            if(committed?.commitState!=='COMMITTED'||committed.clientRequestId!==r.clientRequestId)fail('UPLOAD_UNKNOWN');
            return this.record(who,c,committed.receipt);
        }
        return null;
    }
    tick(){
        if(!this.started||this.closing||this.closed)return Promise.resolve({processed:false,...this.state()});
        if(this.inflight)return this.inflight;
        const who=clone(this.captured);this.controller=new AbortController();
        const work=Promise.resolve().then(async()=>{
          try{
            this.dispatchFailure=null;if(!await this.enterDispatch(who))return{processed:false,code:'MAINTENANCE_BUSY'};
            if(this.dispatchPermit)await this.checkDispatch(who);
            this.assertIdentity(who);const chosen=await this.choose(who);if(!chosen)return{processed:false};if(chosen.scanProgress)return{processed:false,scanProgress:true};this.activeContext=chosen;
            if(this.dispatchPermit)await this.checkDispatch(who);
            try{await this.step(who,chosen);if(this.dispatchFailure)throw this.dispatchFailure;if(this.dispatchPermit)await this.checkDispatch(who);this.assertIdentity(who);this.batches.schedulerProject(who,chosen.batch.batchId);return{processed:true,itemId:chosen.item.itemId};}
            catch(error){
                if(error?.code==='CRASH_TEST')throw error;
                if(error?.code==='AUTH_CHANGED'||error?.status===401)throw Object.assign(new Error('identity unavailable'),{code:'AUTH_CHANGED'});
                if(['VERSION_CONFLICT','BATCH_PAUSED','ITEM_TERMINAL'].includes(error?.code))return{processed:false,code:error.code};
                try{this.defer(who,chosen,error);this.batches.schedulerProject(who,chosen.batch.batchId);}catch(nested){if(nested?.code!=='VERSION_CONFLICT')throw nested;}
                return{processed:true,itemId:chosen.item.itemId,code:error?.code||'REMOTE_UNAVAILABLE'};
            }
          }finally{await this.leaveDispatch(who);}
        });
        const tracked=work.catch(error=>{this.closing=true;this.started=false;this.automatic=false;if(this.alarm!==null)this.timers.clearTimeout(this.alarm);this.alarm=null;this.controller?.abort(error?.code==='AUTH_CHANGED'?'identity-changed':'scheduler-failure');throw error;});
        this.inflight=tracked.finally(()=>{this.inflight=null;this.controller=null;this.activeContext=null;try{this.assertIdentity(who);}catch{this.closing=true;this.started=false;this.automatic=false;if(this.alarm!==null)this.timers.clearTimeout(this.alarm);this.alarm=null;}if(this.closing){this.closed=!this.dispatchLease;if(this.closed)this.release();}});
        return this.inflight;
    }
    async pump({maxSteps=256}={}){integer(maxSteps,1,256);let processed=0;for(let i=0;i<maxSteps;i++){const result=await this.tick();if(!result.processed&&!result.scanProgress)break;if(result.processed)processed++;}return{processed,...this.state()};}
    command(batchId,input){
        if(!this.started||this.closing)fail('SCHEDULER_CLOSED');
        const who=clone(this.captured);this.assertIdentity(who);const result=this.batches.command(who,id(batchId),input);
        if(input.action==='stop'&&this.activeContext?.batch.batchId===batchId)this.controller?.abort('stop-command');
        this.arm();return result;
    }
    async dispose({timeoutMs=5000}={}){
        integer(timeoutMs,0,30000);this.closing=true;this.started=false;
        if(this.alarm!==null)this.timers.clearTimeout(this.alarm);this.alarm=null;
        this.controller?.abort('dispose');
        if(this.deadline!==null)this.timers.clearTimeout(this.deadline);this.deadline=null;
        const active=this.inflight;
        if(!active){if(this.dispatchLease)return{closed:false,unknown:true,inflight:0,timers:this.state().timers};this.closed=true;this.release();return{closed:true,unknown:false,inflight:0,timers:0};}
        let timer;
        const outcome=await Promise.race([active.then(()=>true,()=>true),new Promise(resolve=>{timer=this.timers.setTimeout(()=>resolve(false),timeoutMs);})]);
        if(timer!==undefined)this.timers.clearTimeout(timer);
        if(!outcome)return{closed:false,unknown:true,inflight:1,timers:this.state().timers};
        if(this.dispatchLease)return{closed:false,unknown:true,inflight:0,timers:this.state().timers};
        this.closed=true;this.release();return{closed:true,unknown:false,inflight:0,timers:this.state().timers};
    }
}
