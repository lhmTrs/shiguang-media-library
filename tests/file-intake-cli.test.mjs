import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {intake} from '../scripts/finder-intake.mjs';

// This is the real CLI with owned executable fixtures, not a fake service. The
// stub launcher only writes a marker: it creates no App, port or model request.
async function fixture(behavior) {
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sg-intake-cli-')));
  const project=path.join(dir,'project'),dataDir=path.join(dir,'data'),helper=path.join(dir,'prompt-fixture');
  const marker=path.join(dir,'launcher-called'),file=path.join(dir,'own.mp4'),config=path.join(dir,'install.json');
  await fs.mkdir(path.join(project,'scripts'),{recursive:true});
  await fs.writeFile(file,'owned fixture, never uploaded');
  await fs.writeFile(path.join(project,'scripts/launch.mjs'),"import fs from 'node:fs';fs.writeFileSync("+JSON.stringify(marker)+",'called');");
  await fs.writeFile(helper,'#!'+process.execPath+'\n'+behavior+'\n',{mode:0o700});
  await fs.writeFile(config,JSON.stringify({format:1,node:process.execPath,project,dataDir,helper,personalItemDirectory:path.join(dir,'personal_item')}),{mode:0o600});
  return {dir,config,file,marker,dataDir};
}
const options={skip:process.platform==='win32',timeout:10000};
for(const [name,behavior] of [
  ['normal exit0 without acknowledgement','process.exit(0);'],
  ['acknowledgement for a different handoff',"console.log(JSON.stringify({action:'start',handoffId:'another-selection'}));"],
  ['a non-start acknowledgement',"console.log(JSON.stringify({action:'cancel',handoffId:process.argv[3]}));"],
  ['malformed acknowledgement',"console.log('not json');"],
])test('Service-off CLI refuses '+name,options,async()=>{
  const f=await fixture(behavior);
  await assert.rejects(intake(f.config,[f.file]),e=>e.code==='INTAKE_START_NOT_CONFIRMED');
  await assert.rejects(fs.access(f.marker),e=>e.code==='ENOENT');
  assert.equal(await fs.readFile(f.file,'utf8'),'owned fixture, never uploaded');
  assert.equal((await fs.readdir(path.join(f.dataDir,'file-intake/handoffs'))).length,1);
});
test('Service-off explicit cancellation keeps selection and never invokes launcher',options,async()=>{
  const f=await fixture('process.exit(2);'),result=await intake(f.config,[f.file]);
  assert.equal(result.cancelled,true);assert.match(result.handoffId,/^[a-f0-9-]{36}$/);
  await assert.rejects(fs.access(f.marker),e=>e.code==='ENOENT');await fs.access(f.file);
});
test('Only the exact handoff affirmative acknowledgement reaches the launcher',options,async()=>{
  const f=await fixture("console.log(JSON.stringify({action:'start',handoffId:process.argv[3]}));");
  // The fixture launcher intentionally starts no service: this failure proves
  // that consent passed without pretending that an App launch was verified.
  await assert.rejects(intake(f.config,[f.file]),e=>e.code==='INTAKE_START_FAILED');
  assert.equal(await fs.readFile(f.marker,'utf8'),'called');await fs.access(f.file);
});
test('A failed native prompt never invokes the launcher',options,async()=>{
  const f=await fixture('process.exit(1);');
  await assert.rejects(intake(f.config,[f.file]),e=>e.code==='INTAKE_WINDOW_UNAVAILABLE');
  await assert.rejects(fs.access(f.marker),e=>e.code==='ENOENT');await fs.access(f.file);
});
