import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {spawnSync} from 'node:child_process';
import express from 'express';
import {Library} from '../server/library.mjs';
import {Projects} from '../server/projects.mjs';
import {ProjectAssets} from '../server/project-assets/store.mjs';
import {StoryboardDatabase} from '../server/storyboard/database.mjs';
import {createStoryboardVideo} from '../server/storyboard-video/index.mjs';
import {ProjectVideos} from '../server/project-videos/store.mjs';
import {ManagedIntakeCatalog} from '../server/file-intake/media-catalog.mjs';
import {IntakePreferences} from '../server/file-intake/preferences.mjs';
import {FileIntake} from '../server/file-intake/store.mjs';
import {fileIntakeRouter} from '../server/file-intake/router.mjs';

async function fixture(t) {
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sg-intake-prompt-')));
  const dataDir=path.join(dir,'data'),directory=path.join(dir,'owned');
  let runtime,server;
  async function open() {
    const lib=await new Library(dataDir,{directoryClassification:true}).init();
    lib.enqueue=()=>{};
    const projects=new Projects(lib).init(),assets=new ProjectAssets(lib).init();
    const storyboards=new StoryboardDatabase(lib,assets).init();
    const entry=createStoryboardVideo({lib,storyboards,command:'ffprobe'});
    const catalog=new ProjectVideos(entry.store,{directory:path.join(directory,'video')});
    const generic=await new ManagedIntakeCatalog({catalog,assets,dataDir,directory}).init();
    const preferences=await new IntakePreferences({dataDir,libraryId:dataDir}).init();
    const trash=[];
    const intake=await new FileIntake({dataDir,catalog,projects,generic,preferences,trash:async file=>{
      trash.push(file);
      const destination=file+'.owned-trash';
      await fs.rename(file,destination);
      return destination;
    }}).init();
    assert.equal(intake.initializationError,undefined);
    runtime={lib,projects,assets,entry,catalog,generic,preferences,intake,trash};
    return runtime;
  }
  async function close() {
    if(!runtime)return;
    await runtime.intake.close();
    await runtime.catalog.close();
    await runtime.entry.close();
    assert.equal(runtime.entry.media.children.size,0);
    assert.equal(runtime.entry.media.handles.size,0);
    runtime.lib.db.close();
    runtime=null;
  }
  t.after(async()=>{
    if(server)await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    if(runtime) {
      // Duplicate/failed import stages are intentionally retained by production.
      // Remove only paths proved to belong to these disposable test imports.
      const rows=runtime.lib.db.prepare('SELECT data_json FROM project_video_imports').all();
      for(const row of rows) {
        const raw=JSON.parse(row.data_json);
        if(raw.cache&&path.dirname(raw.cache)===await fs.realpath(os.tmpdir())&&
            path.basename(raw.cache).startsWith('shiguang-project-video-import-'))
          await fs.rm(raw.cache,{recursive:true,force:true});
      }
    }
    await close();
    await fs.rm(dir,{recursive:true,force:true});
  });
  await open();
  const project=runtime.projects.save(null,{name:'提示词收纳合成项目'});
  const other=runtime.projects.save(null,{name:'提示词收纳另一项目'});
  const file=path.join(dir,'clip.mp4');
  const encoded=spawnSync(process.env.FFMPEG_PATH||'ffmpeg',[
    '-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=64x64:r=2:d=1',
    '-c:v','libx264','-pix_fmt','yuv420p','-threads','1',file,
  ]);
  assert.equal(encoded.status,0,encoded.stderr?.toString());
  const bytes=await fs.readFile(file);
  const f={dir,dataDir,directory,project,other,file,bytes,get r(){return runtime;}};
  f.restart=async()=>{
    await close();
    await open();
  };
  f.accept=async({files=[file],destinations,prompt,mode='copy',standardNames}={})=>{
    const h=await runtime.intake.receipts.handoff(files);
    const input={version:2,requestId:randomUUID(),mode,fileIds:h.files.map(f=>f.id),
      targets:h.files.map((f,i)=>({fileId:f.id,destination:destinations?.[i]??{
        kind:'video',scope:'project',projectId:project.id,folderId:'root',
      }})),...(prompt!==undefined?{prompt}:{}),...(standardNames!==undefined?{standardNames}:{})};
    return {h,input};
  };
  f.serve=async()=>{
    const app=express();
    app.use('/api/file-intake',(req,res,next)=>fileIntakeRouter(runtime.intake,{})(req,res,next));
    server=app.listen(0,'127.0.0.1');
    await once(server,'listening');
    const origin='http://127.0.0.1:'+server.address().port;
    f.api=async(url,body)=>{
      const response=await fetch(origin+'/api/file-intake'+url,{
        method:body===undefined?'GET':'POST',
        headers:body===undefined?{}:{'content-type':'application/json'},
        body:body===undefined?undefined:JSON.stringify(body),
      });
      return {status:response.status,body:await response.json()};
    };
  };
  return f;
}

async function settled(intake) {
  const end=Date.now()+15000;
  while(intake.work||intake.status().activeCount) {
    if(Date.now()>end)throw Error('Synthetic intake did not settle');
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  if(intake.lastError)throw intake.lastError;
}

test('real router persists one batch prompt and each imported video gets its own prompt, with durable replay',async t=>{
  const f=await fixture(t);
  await f.serve();
  const second=path.join(f.dir,'second.mp4');
  await fs.writeFile(second,Buffer.concat([f.bytes,Buffer.from('synthetic second')]));
  const prompt={text:'  '+'电影画面提示词'.repeat(10)+'  '};
  const {h,input}=await f.accept({files:[f.file,second],prompt,standardNames:false});
  let reply=await f.api('/handoffs/'+h.id+'/confirm',input);
  assert.equal(reply.status,200,JSON.stringify(reply));
  assert.deepEqual(reply.body.prompt,prompt);
  assert.equal(f.r.preferences.routing.standardNamesChosen,true);
  await settled(f.r.intake);
  const result=await f.api('/batches/'+input.requestId);
  assert.equal(result.body.status,'completed');
  const prompts=f.r.catalog.prompts(f.project.id);
  assert.equal(prompts.length,2);
  assert.deepEqual(prompts.map(p=>({text:p.text,title:p.title})),Array(2).fill({
    text:prompt.text.trim(),title:prompt.text.trim().slice(0,40),
  }));
  const records=f.r.catalog.db.prepare('SELECT data_json FROM project_video_records WHERE project_id=?').all(f.project.id);
  assert.equal(new Set(records.map(r=>JSON.parse(r.data_json).promptId)).size,2);
  const persisted=await f.r.intake.receipts.read('batches',input.requestId);
  assert.deepEqual(persisted.prompt,prompt);
  assert.deepEqual(JSON.parse(persisted.args).prompt,prompt);
  reply=await f.api('/handoffs/'+h.id+'/confirm',input);
  assert.equal(reply.status,200);
  assert.equal(f.r.catalog.prompts(f.project.id).length,2);
  const changed=await f.api('/handoffs/'+h.id+'/confirm',{...input,prompt:{text:'另一个提示词'}});
  assert.equal(changed.status,409);
  assert.equal(changed.body.code,'INTAKE_ALREADY_ACCEPTED');
  await f.restart();
  assert.equal(f.r.preferences.routing.standardNames,false);
  reply=await f.api('/handoffs/'+h.id+'/confirm',input);
  assert.equal(reply.status,200);
  assert.deepEqual(reply.body.prompt,prompt);
  assert.equal(f.r.catalog.prompts(f.project.id).length,2);
  assert.deepEqual((await f.api('/batches')).body.batches[0].prompt,prompt);
});

test('prompt validation rejects the entire batch before folders, batch receipts or originals change',async t=>{
  const f=await fixture(t);
  await f.serve();
  const folderRoot=await f.r.catalog.folders.rootPath(f.project.id);
  const target={kind:'video',scope:'project',projectId:f.project.id,folderId:'root',newFolder:{name:'A'}};
  const {h,input}=await f.accept({destinations:[target]});
  for(const prompt of [null,{},'',[],{text:0},{text:''},{text:' \n '},{text:'x'.repeat(200001)},
    {text:'x',title:'x'.repeat(241)},{text:'x',title:null},{text:'x',title:0},{text:'\0'},
    {text:'x',mode:'none'}]) {
    const response=await f.api('/handoffs/'+h.id+'/confirm',{...input,prompt});
    assert.equal(response.status,400,JSON.stringify(response));
    assert.equal(response.body.accepted,false);
    assert.equal(response.body.requestId,input.requestId);
  }
  const second=path.join(f.dir,'second.mp4');
  await fs.copyFile(f.file,second);
  const mixed=await f.accept({files:[f.file,second],destinations:[target,{kind:'video',scope:'library'}]});
  for(const unsupported of [
    {kind:'video',scope:'library'},
    {kind:'photo',scope:'library'},
    {kind:'photo',scope:'project',projectId:f.project.id},
    {kind:'music',scope:'library'},
    {kind:'sfx',scope:'library'},
  ]) {
    const targets=[mixed.input.targets[0],{...mixed.input.targets[1],destination:unsupported}];
    const denied=await f.api('/handoffs/'+mixed.h.id+'/confirm',{...mixed.input,targets,prompt:{text:'整批提示词'}});
    assert.equal(denied.status,400);
    assert.equal(denied.body.code,'INTAKE_PROMPT_TARGET_UNSUPPORTED');
    assert.equal(denied.body.accepted,false);
  }
  assert.equal(f.r.intake.batches.size,0);
  assert.deepEqual(await f.r.intake.receipts.list('batches'),[]);
  await assert.rejects(fs.access(folderRoot),{code:'ENOENT'});
  assert.equal(f.r.catalog.folders.rows(f.project.id).length,0);
  assert.equal(f.r.lib.db.prepare('SELECT COUNT(*) n FROM project_video_imports').get().n,0);
  assert.equal(f.r.catalog.prompts(f.project.id).length,0);
  assert.deepEqual(await fs.readFile(f.file),f.bytes);
  assert.deepEqual(await fs.readFile(second),f.bytes);
  assert.equal(f.r.preferences.routing.standardNamesChosen,false);
  assert.equal(f.r.trash.length,0);
});

test('v1 rejects an explicit prompt and absent prompts preserve both v1 and v2 import behavior',async t=>{
  const f=await fixture(t),first=await f.accept();
  const legacy={requestId:first.input.requestId,projectId:f.project.id,folderId:'root',mode:'copy',fileIds:first.input.fileIds};
  await assert.rejects(f.r.intake.confirm(first.h.id,{...legacy,prompt:{text:'不能忽略'}}),{
    code:'INTAKE_INVALID_INPUT',accepted:false,
  });
  const v1=await f.r.intake.confirm(first.h.id,legacy);
  assert.equal(Object.hasOwn(v1,'prompt'),false);
  await settled(f.r.intake);
  await f.restart();
  assert.equal((await f.r.intake.confirm(first.h.id,legacy)).items[0].status,'ready');
  const file=path.join(f.dir,'plain.mp4');
  await fs.writeFile(file,Buffer.concat([f.bytes,Buffer.from('plain fixture')]));
  const second=await f.accept({files:[file]});
  await f.r.intake.confirm(second.h.id,second.input);
  await settled(f.r.intake);
  await f.restart();
  assert.equal(Object.hasOwn(await f.r.intake.confirm(second.h.id,second.input),'prompt'),false);
  assert.equal(f.r.catalog.prompts(f.project.id).length,0);
  assert.equal(f.r.catalog.db.prepare('SELECT COUNT(*) n FROM project_video_records').get().n,2);
});

test('lost upload response and interrupted accepted batch reconcile without duplicating prompts',async t=>{
  const f=await fixture(t),prompt={text:'跨重启提示词',title:'明确标题'};
  const {h,input}=await f.accept({prompt});
  const upload=f.r.catalog.upload.bind(f.r.catalog);
  f.r.catalog.upload=async(...args)=>{
    await upload(...args);
    throw Error('Synthetic response lost after durable registration');
  };
  await f.r.intake.confirm(h.id,input);
  await settled(f.r.intake);
  assert.equal(f.r.intake.batch(input.requestId).items[0].status,'unknown');
  assert.equal(f.r.catalog.prompts(f.project.id).length,1);
  await f.restart();
  const replay=await f.r.intake.confirm(h.id,input);
  assert.deepEqual(replay.prompt,prompt);
  assert.equal(replay.items[0].status,'unknown');
  const result=await f.r.intake.reconcile(input.requestId);
  assert.equal(result.items[0].status,'ready');
  assert.equal(f.r.catalog.prompts(f.project.id).length,1);
  assert.equal(f.r.catalog.prompts(f.project.id)[0].title,prompt.title);

  const file=path.join(f.dir,'restart-queued.mp4');
  await fs.writeFile(file,Buffer.concat([f.bytes,Buffer.from('queued fixture')]));
  const queued=await f.accept({files:[file],prompt});
  f.r.intake.kick=()=>{};
  await f.r.intake.confirm(queued.h.id,queued.input);
  await f.restart();
  assert.deepEqual(f.r.intake.dto(f.r.intake.batch(queued.input.requestId)).prompt,prompt);
  assert.equal(f.r.intake.batch(queued.input.requestId).status,'interrupted');
  await f.r.intake.reconcile(queued.input.requestId);
  const item=f.r.intake.batch(queued.input.requestId).items[0];
  assert.equal(item.status,'failed');
  await f.r.intake.retry(queued.input.requestId,item.id);
  await settled(f.r.intake);
  assert.equal(item.status,'ready',item.error);
  assert.equal(f.r.catalog.prompts(f.project.id).length,2);
  assert.deepEqual(f.r.catalog.prompts(f.project.id).map(p=>p.text),[prompt.text,prompt.text]);
});

test('reuse retains existing video metadata while import creates a distinct prompt for the new copy',async t=>{
  const f=await fixture(t),original={text:'原始提示词',title:'原始名称'};
  const seed=await f.accept({prompt:original});
  await f.r.intake.confirm(seed.h.id,seed.input);
  await settled(f.r.intake);
  const videoId=f.r.intake.batch(seed.input.requestId).items[0].videoId;
  const before=f.r.catalog.row(f.project.id,videoId);
  const added={text:'本次附带的新提示词',title:'新提示词'};
  const reused=await f.accept({prompt:added});
  await f.r.intake.confirm(reused.h.id,reused.input);
  await settled(f.r.intake);
  const duplicate=f.r.intake.batch(reused.input.requestId).items[0];
  assert.equal(duplicate.status,'duplicate');
  const result=await f.r.intake.resolve(reused.input.requestId,duplicate.id,{
    choice:'reuse',candidateId:duplicate.candidates[0].id,
  });
  assert.equal(result.items[0].videoId,videoId);
  assert.deepEqual(f.r.catalog.row(f.project.id,videoId),before);
  assert.equal(f.r.catalog.prompts(f.project.id).length,1);
  assert.deepEqual(result.prompt,added,'batch DTO describes the submitted prompt without rewriting the existing video');
  const imported=await f.accept({prompt:added});
  await f.r.intake.confirm(imported.h.id,imported.input);
  await settled(f.r.intake);
  const d=f.r.intake.batch(imported.input.requestId).items[0];
  const copy=await f.r.intake.resolve(imported.input.requestId,d.id,{choice:'import'});
  assert.equal(copy.items[0].status,'ready');
  assert.notEqual(copy.items[0].videoId,videoId);
  assert.equal(f.r.catalog.prompts(f.project.id).length,2);
  assert.deepEqual(f.r.catalog.row(f.project.id,videoId),before);
});

test('manual text beyond 10000 characters and project-video maximum lengths pass the real route',async t=>{
  const f=await fixture(t);
  await f.serve();
  const prompt={text:'p'.repeat(200000),title:'名'.repeat(240)};
  const {h,input}=await f.accept({prompt});
  const response=await f.api('/handoffs/'+h.id+'/confirm',input);
  assert.equal(response.status,200,JSON.stringify(response.body));
  await settled(f.r.intake);
  const [saved]=f.r.catalog.prompts(f.project.id);
  assert.equal(saved.text,prompt.text);
  assert.equal(saved.title,prompt.title);
  assert.equal(f.r.intake.dto(f.r.intake.batch(input.requestId)).items[0].status,'ready');
  const changed=await f.api('/handoffs/'+h.id+'/confirm',{...input,prompt:{...prompt,title:'另一个标题'}});
  assert.equal(changed.status,409);
  assert.equal(changed.body.code,'INTAKE_ALREADY_ACCEPTED');
});

test('one batch can attach the same text independently in two project video catalogs',async t=>{
  const f=await fixture(t),second=path.join(f.dir,'other.mp4');
  await fs.writeFile(second,f.bytes);
  const prompt={text:'两个项目共用的批次正文',title:''};
  const {h,input}=await f.accept({files:[f.file,second],prompt,destinations:[
    {kind:'video',scope:'project',projectId:f.project.id,folderId:'root'},
    {kind:'video',scope:'project',projectId:f.other.id,folderId:'root'},
  ]});
  await f.r.intake.confirm(h.id,input);
  await settled(f.r.intake);
  for(const p of [f.project,f.other]){
    const [saved]=f.r.catalog.prompts(p.id);
    assert.equal(saved.text,prompt.text);
    assert.equal(saved.title,prompt.text.slice(0,40));
  }
  assert.equal(f.r.intake.dto(f.r.intake.batch(input.requestId)).status,'completed');
});
