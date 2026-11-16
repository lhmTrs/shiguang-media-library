import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Receipts} from '../server/file-intake/files.mjs';

test('published receipt survives owned temporary cleanup failure after durability confirmation',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'sg-receipt-commit-')),receipts=await new Receipts(root).init(),id=randomUUID(),value={id,libraryId:'synthetic-library',args:'synthetic-input'};
 const original=fs.unlink;t.mock.method(fs,'unlink',async file=>{if(file.startsWith(receipts.file('batches',id)+'.')&&file.endsWith('.tmp'))throw Object.assign(Error('synthetic cleanup denied'),{code:'EACCES'});return original(file);});
 await assert.doesNotReject(receipts.write('batches',id,value,{exclusive:true}));assert.deepEqual(await receipts.read('batches',id),value);
});

for(const stage of ['write','file-sync','link','rename','directory-sync','link-observation'])test('receipt commit fault boundary: '+stage,async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'sg-receipt-fault-')),r=await new Receipts(root).init(),id=randomUUID(),value={id,args:'owned'},target=r.file('batches',id),exclusive=stage!=='rename';
 const fault=()=>Object.assign(Error('synthetic IO fault'),{code:'EIO'});
 if(['link','rename','link-observation'].includes(stage)){
  const method=stage==='rename'?'rename':'link',original=fs[method];t.mock.method(fs,method,async(a,b)=>{if(b===target){if(stage==='link-observation')await original(a,b);throw fault();}return original(a,b);});
 }else{
  const original=fs.open;t.mock.method(fs,'open',async(file,...args)=>{
   const h=await original(file,...args),match=stage==='directory-sync'?file===path.dirname(target):String(file).startsWith(target+'.');
   return !match?h:new Proxy(h,{get(h,key){if(key===(stage==='write'?'writeFile':'sync'))return async()=>{throw fault();};const v=h[key];return typeof v==='function'?v.bind(h):v;}});
  });
 }
 const unknown=['directory-sync','link-observation'].includes(stage);
 await assert.rejects(r.write('batches',id,value,{exclusive}),e=>{assert.equal(e.receiptCommitState,unknown?'unknown':'not_committed');if(unknown){assert.equal(e.code,'INTAKE_RESULT_UNKNOWN');assert.equal(e.details.requestId,id);}return true;});
 if(unknown)assert.deepEqual(await r.read('batches',id),value);else await assert.rejects(fs.access(target),{code:'ENOENT'});
});

test('exclusive collision never overwrites or adopts a different receipt',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'sg-receipt-collision-')),r=await new Receipts(root).init(),id=randomUUID();await r.write('batches',id,{id,args:'original'},{exclusive:true});
 await assert.rejects(r.write('batches',id,{id,args:'other'},{exclusive:true}),{code:'INTAKE_RESULT_UNKNOWN',receiptCommitState:'unknown'});assert.equal((await r.read('batches',id)).args,'original');
});

test('publication readback mismatch is unknown and never adopted as successful',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'sg-receipt-readback-')),r=await new Receipts(root).init(),id=randomUUID(),target=r.file('batches',id),original=fs.link;
 t.mock.method(fs,'link',async(a,b)=>{await original(a,b);if(b===target)await fs.writeFile(target,JSON.stringify({id,args:'different-owned-receipt'}));});
 await assert.rejects(r.write('batches',id,{id,args:'expected'},{exclusive:true}),{code:'INTAKE_RESULT_UNKNOWN',receiptCommitState:'unknown'});assert.equal((await r.read('batches',id)).args,'different-owned-receipt');
});
