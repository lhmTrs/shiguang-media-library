import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Receipts} from '../server/file-intake/files.mjs';

import {Library} from '../server/library.mjs';
import {Projects} from '../server/projects.mjs';
import {ProjectAssets} from '../server/project-assets/store.mjs';
import {ManagedIntakeCatalog} from '../server/file-intake/media-catalog.mjs';
import {VideoMedia} from '../server/storyboard-video/media.mjs';
import {FileIntake} from '../server/file-intake/store.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=','base64');
async function intakeFixture(t){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sg-receipt-integration-'))),dataDir=path.join(root,'data'),lib=await new Library(dataDir,{directoryClassification:true}).init();lib.enqueue=()=>{};
 const projects=new Projects(lib).init(),assets=new ProjectAssets(lib).init(),media=new VideoMedia(),catalog={lib,media,db:lib.db};media.probe=()=>assert.fail('photo receipt test must not probe video');
 const generic=await new ManagedIntakeCatalog({catalog,assets,dataDir,directory:path.join(root,'managed')}).init();
 let trash=0;const options={dataDir,catalog,projects,generic,trash:async file=>{trash++;const to=file+'.owned-trash';await fs.rename(file,to);return to;}},intake=await new FileIntake(options).init();
 assert.equal(intake.initializationError,undefined);const file=path.join(root,'synthetic.png');await fs.writeFile(file,png);
 const handoff=await intake.receipts.handoff([file]);
 t.after(async()=>{await intake.close();await media.close();lib.db.close();});
 return {intake,options,file,handoff,trash:()=>trash};
}
const inputFor=(f,mode='copy')=>({version:2,requestId:randomUUID(),mode,fileIds:[f.handoff.files[0].id],targets:[{fileId:f.handoff.files[0].id,destination:{scope:'library',kind:'photo'}}]});
async function settled(intake){for(let n=0;n<200&&(intake.work||intake.timer);n++){if(intake.work)await intake.work;await new Promise(r=>setTimeout(r,5));}assert.equal(intake.work,null);assert.equal(intake.timer,null);}
for(const mode of ['copy','move'])test('durable cleanup failure remains accepted exactly once across repeat and restart: '+mode,async t=>{
 const f=await intakeFixture(t),input=inputFor(f,mode),original=fs.unlink,target=f.intake.receipts.file('batches',input.requestId);
 t.mock.method(fs,'unlink',async file=>{if(String(file).startsWith(target+'.')&&String(file).endsWith('.tmp'))throw Object.assign(Error('owned cleanup denied'),{code:'EPERM'});return original(file);});
 const dto=await f.intake.confirm(f.handoff.id,input);assert.equal(dto.id,input.requestId);await settled(f.intake);
 const before=f.intake.dto(f.intake.batch(dto.id));assert.equal(before.status,'completed',JSON.stringify(before));assert.equal(before.items[0].status,'ready');assert.deepEqual(await f.intake.confirm(f.handoff.id,input),before);
 assert.equal(f.trash(),mode==='move'?1:0);if(mode==='copy')assert.deepEqual(await fs.readFile(f.file),png);else await assert.rejects(fs.access(f.file),{code:'ENOENT'});
 await f.intake.close();const restarted=await new FileIntake(f.options).init();t.after(()=>restarted.close());assert.equal(restarted.initializationError,undefined);assert.deepEqual(restarted.dto(restarted.batch(dto.id)),before);assert.deepEqual(await restarted.confirm(f.handoff.id,input),before);assert.equal(f.trash(),mode==='move'?1:0);
});

test('directory sync unknown never schedules; same request stays unknown, different args/library are refused',async t=>{
 const f=await intakeFixture(t),input=inputFor(f),target=f.intake.receipts.file('batches',input.requestId),original=fs.open;let kicks=0;t.mock.method(f.intake,'kick',()=>kicks++);
 const openMock=t.mock.method(fs,'open',async(file,...args)=>{const h=await original(file,...args);return file!==path.dirname(target)?h:new Proxy(h,{get(h,key){if(key==='sync')return async()=>{throw Object.assign(Error('directory sync failed'),{code:'EIO'});};const v=h[key];return typeof v==='function'?v.bind(h):v;}});});
 await assert.rejects(f.intake.confirm(f.handoff.id,input),{code:'INTAKE_RESULT_UNKNOWN'});assert.equal(kicks,0);assert.equal(f.intake.batches.has(input.requestId),false);openMock.mock.restore();
 await assert.rejects(f.intake.confirm(f.handoff.id,input),{code:'INTAKE_RESULT_UNKNOWN'});await assert.rejects(f.intake.confirm(f.handoff.id,{...input,standardNames:true}),{code:'INTAKE_ALREADY_ACCEPTED'});
 const restarted=await new FileIntake(f.options).init();t.after(()=>restarted.close());const interrupted=restarted.dto(restarted.batch(input.requestId));assert.equal(interrupted.status,'interrupted');assert.equal(interrupted.items[0].status,'unknown');assert.equal(interrupted.canAcknowledge,false);await assert.rejects(restarted.acknowledge(input.requestId,{acknowledged:true,resultKey:interrupted.resultKey}),{code:'INTAKE_NOT_SETTLED'});assert.equal(restarted.work,null);assert.equal(f.trash(),0);
 const saved=await f.intake.receipts.read('batches',input.requestId);await f.intake.receipts.write('batches',input.requestId,{...saved,libraryId:'different-synthetic-library'});await assert.rejects(f.intake.confirm(f.handoff.id,input),{code:'LOCAL_INSTANCE_CHANGED'});assert.equal(kicks,0);assert.deepEqual(await fs.readFile(f.file),png);
});
