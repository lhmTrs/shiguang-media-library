import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {intake} from '../scripts/finder-intake.mjs';
import {Receipts} from '../server/file-intake/files.mjs';

// This is the real CLI with owned executable fixtures, not a fake service. The
// stub launcher only writes a marker: it creates no App, port or model request.
async function fixture(t,behavior) {
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sg-intake-cli-')));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const project=path.join(dir,'project'),dataDir=path.join(dir,'data'),helper=path.join(dir,'prompt-fixture');
  const marker=path.join(dir,'launcher-called'),file=path.join(dir,'own.mp4'),config=path.join(dir,'install.json');
  await fs.mkdir(path.join(project,'scripts'),{recursive:true});
  await fs.writeFile(file,'owned fixture, never uploaded');
  await fs.writeFile(path.join(project,'scripts/launch.mjs'),"import fs from 'node:fs';fs.writeFileSync("+JSON.stringify(marker)+",'called');");
  await fs.writeFile(helper,'#!'+process.execPath+'\n'+behavior+'\n',{mode:0o700});
  await fs.writeFile(config,JSON.stringify({format:1,node:process.execPath,project,dataDir,helper,personalItemDirectory:path.join(dir,'personal_item')}),{mode:0o600});
  return {dir,config,file,marker,dataDir,handoffs:path.join(dataDir,'file-intake','handoffs')};
}
const options={skip:process.platform==='win32',timeout:10000};
for(const [name,behavior] of [
  ['normal exit0 without acknowledgement','process.exit(0);'],
  ['acknowledgement for a different handoff',"console.log(JSON.stringify({action:'start',handoffId:'another-selection'}));"],
  ['a non-start acknowledgement',"console.log(JSON.stringify({action:'cancel',handoffId:process.argv[3]}));"],
  ['malformed acknowledgement',"console.log('not json');"],
])test('Service-off CLI refuses '+name,options,async t=>{
  const f=await fixture(t,behavior);
  await assert.rejects(intake(f.config,[f.file]),e=>e.code==='INTAKE_START_NOT_CONFIRMED');
  await assert.rejects(fs.access(f.marker),e=>e.code==='ENOENT');
  assert.equal(await fs.readFile(f.file,'utf8'),'owned fixture, never uploaded');
  assert.equal((await fs.readdir(path.join(f.dataDir,'file-intake/handoffs'))).length,1);
});
test('Service-off explicit cancellation keeps selection without logging a fingerprint failure or invoking launcher',options,async t=>{
  const prepare=Receipts.prototype.prepareHandoff;
  t.mock.method(Receipts.prototype,'prepareHandoff',async function(id,{signal}){
    if(!signal.aborted)await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
    return prepare.call(this,id,{signal});
  });
  const stderr=t.mock.method(console,'error',()=>{});
  const f=await fixture(t,'process.exit(2);'),result=await intake(f.config,[f.file]);
  assert.equal(result.cancelled,true);assert.match(result.handoffId,/^[a-f0-9-]{36}$/);
  await assert.rejects(fs.access(f.marker),e=>e.code==='ENOENT');await fs.access(f.file);
  const receipt=await new Receipts(f.dataDir).read('handoffs',result.handoffId);
  assert.equal(receipt.preparationDiagnostic.reason,'cancelled');
  assert.deepEqual(await fs.readdir(f.handoffs),[result.handoffId+'.json']);
  assert.equal(stderr.mock.callCount(),0);
});
test('Only the exact handoff affirmative acknowledgement reaches the launcher',options,async t=>{
  const f=await fixture(t,"console.log(JSON.stringify({action:'start',handoffId:process.argv[3]}));");
  // The fixture launcher intentionally starts no service: this failure proves
  // that consent passed without pretending that an App launch was verified.
  await assert.rejects(intake(f.config,[f.file]),e=>e.code==='INTAKE_START_FAILED');
  assert.equal(await fs.readFile(f.marker,'utf8'),'called');await fs.access(f.file);
});
test('A failed native prompt never invokes the launcher',options,async t=>{
  const f=await fixture(t,'process.exit(1);');
  await assert.rejects(intake(f.config,[f.file]),e=>e.code==='INTAKE_WINDOW_UNAVAILABLE');
  await assert.rejects(fs.access(f.marker),e=>e.code==='ENOENT');await fs.access(f.file);
});

test('a background permission failure logs one safe event to stderr and a private per-handoff file',options,async t=>{
  const f=await fixture(t,`
    const fs=require('node:fs'),path=require('node:path');
    const receipt=path.join(__dirname,'data','file-intake','handoffs',process.argv[3]+'.json');
    const deadline=Date.now()+3000;
    setInterval(()=>{
      if(JSON.parse(fs.readFileSync(receipt,'utf8')).preparation==='failed')process.exit(2);
      if(Date.now()>deadline)process.exit(1);
    },10);
  `);
  const open=fs.open;
  t.mock.method(fs,'open',async(p,...args)=>{
    if(p===f.file)throw Object.assign(new Error('private exception: '+f.file),{code:'EPERM'});
    return open(p,...args);
  });
  const stderr=t.mock.method(console,'error',()=>{});
  const {handoffId}=await intake(f.config,[f.file]);
  const receipt=await new Receipts(f.dataDir).read('handoffs',handoffId);
  const log=path.join(f.handoffs,handoffId+'.failure.log');
  const line=await fs.readFile(log,'utf8');
  assert.equal((await fs.stat(log)).mode&0o777,0o600);
  assert.equal(stderr.mock.callCount(),1);
  assert.equal(line,stderr.mock.calls[0].arguments[0]+'\n');
  assert.ok(line.includes(JSON.stringify({handoffId,stage:'fingerprint',reason:'permission',code:'EPERM',fileId:receipt.files[0].id})));
  assert.ok(line.includes(receipt.preparationError));
  assert.ok(!line.includes(f.file)&&!line.includes(receipt.files[0].name)&&!line.includes('private exception'));
  assert.equal(receipt.preparationDiagnostic.fileName,receipt.files[0].name);
  await assert.rejects(fs.access(f.marker),{code:'ENOENT'});
});
