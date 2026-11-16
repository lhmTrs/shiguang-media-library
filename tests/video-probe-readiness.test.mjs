import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {VideoMedia} from '../server/storyboard-video/media.mjs';

test('missing explicit video tool keeps stable business code and a safe actionable cause',async()=>{
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sg-probe-cause-'))),file=path.join(dir,'synthetic.mp4');await fs.writeFile(file,'synthetic video');
 const media=new VideoMedia({command:path.join(dir,'private-name-missing-probe')});
 try{await assert.rejects(media.probe(file),e=>{assert.equal(e.code,'PROBE_UNAVAILABLE');assert.equal(e.diagnostic?.causeCode,'ENOENT');assert.equal(e.diagnostic?.reason,'missing_tool');assert.ok(!JSON.stringify(e.diagnostic).includes(dir));return true;});}
 finally{await media.close();assert.equal(media.handles.size,0);assert.equal(media.children.size,0);}
});

import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {resolveVideoProbe,safeProbeDiagnostic} from '../server/storyboard-video/probe-tool.mjs';
async function sample(t){const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sg-probe-ready-'))),file=path.join(dir,'sample.mp4');await fs.writeFile(file,'owned synthetic video bytes');return {dir,file};}
function hookSpawn(t,fn){const mocked=t.mock.method(cp,'spawn',fn);syncBuiltinESMExports();t.after(()=>{mocked.mock.restore();syncBuiltinESMExports();});}
for(const code of ['EACCES','EPERM','EMFILE','ENFILE','EAGAIN','ENOMEM'])for(const synchronous of [true,false])test('probe safe startup cause '+code+' synchronous='+synchronous,async t=>{
 const {dir,file}=await sample(t),media=new VideoMedia({command:process.execPath});let called=0;
 hookSpawn(t,()=>{called++;const e=Object.assign(Error('private raw error '+dir),{code,errno:-13,syscall:'spawn '+dir+'/private-tool',path:dir,credentials:'must-not-export'});if(synchronous)throw e;
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;setImmediate(()=>{child.emit('error',e);child.emit('close',-1);});return child;
 });
 try{await assert.rejects(media.probe(file),e=>{assert.equal(e.code,'PROBE_UNAVAILABLE');assert.equal(e.diagnostic.stage,'spawn');assert.equal(e.diagnostic.causeCode,code);assert.equal(e.diagnostic.syscall,'spawn');assert.equal(e.diagnostic.errno,-13);assert.equal(e.diagnostic.reason,['EACCES','EPERM'].includes(code)?'permission_denied':'resource_exhausted');assert.ok(!JSON.stringify(e).includes(dir));return true;});assert.equal(called,1);}
 finally{await media.close();assert.equal(media.handles.size,0);assert.equal(media.probes,0);}
});

test('explicit path precedence, minimal PATH discovery, executable checks and absent tools',async t=>{
 const {dir}=await sample(t),env={PATH:''};
 assert.equal((await resolveVideoProbe({command:process.execPath,explicit:true,env,defaults:[]})).command,await fs.realpath(process.execPath));
 assert.equal((await resolveVideoProbe({env,defaults:[process.execPath]})).command,await fs.realpath(process.execPath));
 await assert.rejects(resolveVideoProbe({command:path.join(dir,'missing'),explicit:true,env,defaults:[process.execPath]}),e=>e.code==='PROBE_UNAVAILABLE'&&e.diagnostic.causeCode==='ENOENT');
 await assert.rejects(resolveVideoProbe({env,defaults:[]}),e=>e.diagnostic.reason==='missing_tool');
 const blocked=path.join(dir,'not-executable');await fs.writeFile(blocked,'owned',{mode:0o600});
 if(process.platform!=='win32')await assert.rejects(resolveVideoProbe({command:blocked,explicit:true,env}),e=>e.diagnostic.reason==='permission_denied');
 await assert.rejects(resolveVideoProbe({command:'relative/tool',explicit:true,env}),e=>e.diagnostic.reason==='invalid_config');
 const executable=path.basename(process.execPath);assert.equal((await resolveVideoProbe({command:executable,explicit:true,env:{PATH:path.dirname(process.execPath)},defaults:[]})).command,await fs.realpath(process.execPath));
});

test('diagnostic projection rejects raw fields and invalid reasons/codes',()=>{
 assert.equal(safeProbeDiagnostic({stage:'secret',reason:'missing_tool'}),undefined);
 assert.deepEqual(safeProbeDiagnostic({stage:'spawn',reason:'spawn_failed',causeCode:'untrusted private string',errno:999999,syscall:'spawn /private',path:'/private',token:'secret'}),{stage:'spawn',reason:'spawn_failed'});
});

test('probe timeout retains stable code and awaits owned child exit and descriptor close',async t=>{
 const {file}=await sample(t),media=new VideoMedia({command:process.execPath,probeMs:10});
 hookSpawn(t,()=>{const child=new EventEmitter();child.pid=123;child.stdout=new PassThrough();child.stderr=new PassThrough();let stopped=false;child.kill=()=>{if(!stopped){stopped=true;setImmediate(()=>child.emit('close',1));}return true;};return child;});
 try{await assert.rejects(media.probe(file),e=>e.code==='PROBE_TIMEOUT'&&e.diagnostic.reason==='timeout');}
 finally{await media.close();assert.equal(media.children.size,0);assert.equal(media.exits.size,0);assert.equal(media.handles.size,0);}
});

test('absolute synthetic probe runs with a minimal inherited PATH and closes normally',{skip:process.platform==='win32'},async t=>{
 const {dir,file}=await sample(t),tool=path.join(dir,'owned-probe'),payload={format:{duration:'1'},streams:[{codec_type:'video',codec_name:'h264',width:64,height:64}]};
 await fs.writeFile(tool,'#!'+process.execPath+'\nprocess.stdout.write('+JSON.stringify(JSON.stringify(payload))+');\n',{mode:0o700});
 const previous=process.env.PATH;process.env.PATH=dir;t.after(()=>{if(previous===undefined)delete process.env.PATH;else process.env.PATH=previous;});
 const media=new VideoMedia({command:tool});try{const result=await media.probe(file,{includeDimensions:true});assert.equal(result.durationMs,1000);assert.equal(result.width,64);assert.equal(result.supported,true);}finally{await media.close();assert.equal(media.children.size,0);assert.equal(media.handles.size,0);}
});
