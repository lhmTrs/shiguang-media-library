import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {IncomingMessage,ServerResponse} from 'node:http';
import {Duplex} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {createConciergeCapabilities} from '../server/concierge/capabilities.mjs';
import {creativeFixture} from './helpers/creative-fixture.mjs';
import {syntheticSource} from './helpers/storyboard-fixture.mjs';
import {ProjectScripts} from '../server/project-scripts/store.mjs';
import {StoryboardDatabase} from '../server/storyboard/database.mjs';
import {projectAssetRouter} from '../server/project-assets/router.mjs';
import {createStoryboardModule} from '../server/storyboard/router.mjs';
import {PromptTemplates} from '../server/prompt-templates/store.mjs';
import {promptRouter} from '../server/prompt-templates/router.mjs';
const cap=createConciergeCapabilities();
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
async function fixture(t){
 const f=await creativeFixture();t.after(()=>f.close());
 const scripts=new ProjectScripts(f.store).init(),board=new StoryboardDatabase(f.lib,f.store).init(),templates=new PromptTemplates(f.lib).init();
 const app=express();app.use(express.json());app.get('/api/projects',(_req,res)=>res.json(f.projects.list()));app.use('/api/project-assets',projectAssetRouter(f.store,wrap));
 const storyboard=createStoryboardModule({dataDir:f.dir,lib:f.lib,projectAssets:f.store});t.after(()=>storyboard.close());app.use('/api/storyboard',storyboard.router);app.use('/api/prompt-templates',promptRouter(templates,wrap));
 app.get('/api/assets',(_req,res)=>res.json({items:[f.lib.asset(f.media)],total:1}));app.get('/api/assets/:id',(req,res)=>res.json(f.lib.asset(req.params.id)));
 app.get('/api/storyboard-video/projects/:id/state',(req,res)=>res.json({projectId:req.params.id,sources:[],takes:[],adopted:{}}));
 app.use((e,_req,res,_next)=>res.status(e.status??500).json({error:e.message,current_revision:e.current_revision}));
 // Exercise existing Express routers without opening any network listener.
 const calls=[];const invoke=(method,url,body)=>new Promise((resolve,reject)=>{
  calls.push({method,path:url,body:structuredClone(body)});const socket=new Duplex({read(){},write(_chunk,_enc,cb){cb();}}),req=new IncomingMessage(socket);req.method=method;req.url=url;req.headers={host:'127.0.0.1'};
  if(body!==undefined){req.headers['content-type']='application/json';req.headers['content-length']=String(Buffer.byteLength(JSON.stringify(body)));}
  const res=new ServerResponse(req),chunks=[];res.write=(b)=>{chunks.push(Buffer.from(b));return true;};res.end=(b)=>{if(b)chunks.push(Buffer.from(b));const raw=Buffer.concat(chunks).toString();try{const value=JSON.parse(raw);if(res.statusCode>=400)reject(Object.assign(Error(value.error??value.message),{status:res.statusCode,...value}));else resolve(value);}catch(e){reject(e);}res.emit('finish');};
  app.handle(req,res);req.push(body===undefined?null:JSON.stringify(body));if(body!==undefined)req.push(null);
 });
 return {...f,scripts,board,templates,invoke,calls,run:(scope,operationId,args={},options={})=>cap.execute(scope,{operationId,args},{invoke,...options})};
}

test('catalog/docs/execute share exact immutable schemas and facade identifiers',async()=>{
 assert.ok(cap.definitions.length>=17);assert.equal(new Set(cap.definitions.map(d=>d.operationId)).size,cap.definitions.length);
 const scope=randomUUID();for(const s of ['global',scope]){const c=cap.catalog(s),d=cap.docs(s);assert.deepEqual(c.operations,d.operations);for(const item of c.operations){assert.deepEqual(cap.docs(s,{operationId:item.operationId}).operations,[item]);assert.equal(item.inputSchema.additionalProperties,false);}}
 assert.match(cap.docs('global').description,/不是现有HTTP路径/);assert.match(cap.docs('global').description,/allowWrites 默认false/);assert.equal(cap.docs(scope,{query:'精确修改'}).operations[0].operationId,'storyboards.updateShot');
 const catalog=cap.catalog('global');catalog.operations[0].title='mutated';assert.notEqual(cap.catalog('global').operations[0].title,'mutated');assert.throws(()=>{cap.definitions[0].title='mutated';});
 assert.throws(()=>cap.catalog('../scope'));assert.throws(()=>cap.docs('global',{operationId:'scripts.read'}));
});
test('default read-only, strict schemas, unknown IDs/URLs and abort never reach invoke',async()=>{
 const scope=randomUUID();let calls=0;const invoke=async()=>{calls++;return {};};
 for(const [operationId,args,options]of [
  ['scripts.save',{title:'x',content:'x',expected_revision:0},{}],
  ['scripts.save',{title:'x',content:'x',expected_revision:0},{allowWrites:'true'}],
  ['/api/projects',{},{}],['materials.search',{url:'https://evil'},{}],['materials.read',{id:'../secrets'},{}],
  ['creative.update',{id:randomUUID(),expected_revision:1,patch:{project_id:randomUUID()}},{allowWrites:true}],
  ['storyboards.updateShot',{shot_id:'x',expected_revision:1,asset_stamp:'0'.repeat(64),patch:{id:'new'}},{allowWrites:true}],
  ['templates.save',{id:randomUUID(),expected_revision:1,definition:{name:'x',body:'x',fields:[]}},{allowWrites:true}],
 ])await assert.rejects(cap.execute(scope,{operationId,args},{invoke,...options}));
 const signal=AbortSignal.abort();await assert.rejects(cap.execute(scope,{operationId:'scripts.read',args:{}},{invoke,signal}),/中止/);assert.equal(calls,0);
 await assert.rejects(cap.execute('global',{operationId:'creative.list',args:{target:'current',kind:'character'}},{invoke}),/不可指定/);assert.equal(calls,0);
});
test('existing routers: project reads and script GET-before-PUT retain revision conflicts',async t=>{
 const f=await fixture(t),scope=f.a.id;assert.equal((await f.run('global','projects.list')).length,2);assert.deepEqual((await f.run(scope,'projects.list')).map(p=>p.id),[scope]);assert.equal((await f.run(scope,'projects.overview')).id,scope);
 const initial=await f.run(scope,'scripts.read');assert.equal(initial.revision,0);const saved=await f.run(scope,'scripts.save',{title:'合成',content:'长文\n'.repeat(100),expected_revision:0},{allowWrites:true});assert.equal(saved.revision,1);
 const writes=f.calls.filter(c=>c.method==='PUT');assert.deepEqual(writes[0].body,{title:'合成',content:'长文\n'.repeat(100),expected_revision:0});await assert.rejects(f.run(scope,'scripts.save',{title:'旧',content:'旧',expected_revision:0},{allowWrites:true}),e=>e.status===409);assert.equal(f.scripts.get(scope).title,'合成');
 assert.equal((await f.run(f.b.id,'scripts.read')).content,'');
});
test('assets: project/public read scope, metadata-only updates, exact shots route and no cross-project writes',async t=>{
 const f=await fixture(t),scope=f.a.id,pub=f.store.scopes().items.find(p=>p.project_kind==='public').id;
 const own=await f.store.create({project_id:scope,kind:'scene',name:'客厅'}),other=await f.store.create({project_id:f.b.id,kind:'prop',name:'别人的包'}),shared=await f.store.create({project_id:pub,kind:'character',name:'公共人物'});
 assert.equal((await f.run(scope,'creative.list',{target:'current',kind:'scene'})).items[0].id,own.id);assert.equal((await f.run('global','creative.list',{target:'public',kind:'character'})).items[0].id,shared.id);assert.equal((await f.run(scope,'creative.read',{id:shared.id})).name,'公共人物');
 await assert.rejects(f.run(scope,'creative.read',{id:other.id}),/其他项目/);await assert.rejects(f.run('global','creative.read',{id:own.id}),/其他项目/);await assert.rejects(f.run('global','creative.list',{target:'public',kind:'scene'}),/仅支持人物/);
 const edited=await f.run(scope,'creative.update',{id:own.id,expected_revision:1,patch:{base_info:'新资料'}},{allowWrites:true});assert.equal(edited.base_info,'新资料');assert.deepEqual(edited.images,own.images);assert.equal(edited.kind,'scene');assert.equal(edited.project_id,scope);
 const state=await f.run(scope,'creative.shots',{id:own.id});assert.equal(state.projectId,scope);assert.ok(f.calls.some(c=>c.path===`/api/project-assets/assets/${own.id}/shots`));
 await assert.rejects(f.run(scope,'creative.update',{id:shared.id,expected_revision:1,patch:{name:'禁止跨范围'}},{allowWrites:true}),/其他项目/);
 const publicEdit=await f.run('global','creative.update',{id:shared.id,expected_revision:1,patch:{base_info:'公共资料'}},{allowWrites:true});assert.equal(publicEdit.base_info,'公共资料');
 await assert.rejects(f.run(scope,'creative.update',{id:own.id,expected_revision:1,patch:{base_info:'过期'}},{allowWrites:true}),e=>e.status===409);assert.equal(f.store.get(own.id).base_info,'新资料');
});
test('single-shot update preserves document, other shots and asset stamp; conflicts never overwrite',async t=>{
 const f=await fixture(t),scope=f.a.id,source=syntheticSource();source.scenes[0].shots.push({...structuredClone(source.scenes[0].shots[0]),id:'second-shot',dialogue:[]});const initial=f.board.initialize(scope,{source,request_id:randomUUID(),expected_revision:null}),shot=initial.project.scenes[0].shots[0];
 const read=await f.run(scope,'storyboards.shot',{shot_id:shot.id});assert.equal(read.asset_stamp,initial.asset_stamp);
 const args={shot_id:shot.id,expected_revision:initial.revision,asset_stamp:initial.asset_stamp,patch:{action:'精确单镜新动作'}};
 const saved=await f.run(scope,'storyboards.updateShot',args,{allowWrites:true});assert.equal(saved.project.scenes[0].shots[0].action,'精确单镜新动作');assert.deepEqual(saved.project.scenes[0].shots[1],initial.project.scenes[0].shots[1]);assert.deepEqual(saved.project.asset_manifest,initial.project.asset_manifest);assert.equal(f.calls.find(c=>c.method==='PUT').body.asset_stamp,initial.asset_stamp);
 await assert.rejects(f.run(scope,'storyboards.updateShot',args,{allowWrites:true}),e=>e.status===409);const a=f.store.get(saved.project.asset_manifest.character[0].id);await f.store.save(a.id,{...a,base_info:'changed'},a.revision);
 await assert.rejects(f.run(scope,'storyboards.updateShot',{...args,expected_revision:saved.revision},{allowWrites:true}),/资产资料/);assert.equal(f.board.read(scope).project.scenes[0].shots[0].action,'精确单镜新动作');
 await assert.rejects(f.run(scope,'storyboards.shot',{shot_id:'1'}),/不存在/);
});
test('GET/PUT race propagates existing HTTP conflict without retry; abort before mutation',async t=>{
 const f=await fixture(t),scope=f.a.id;let puts=0;
 const invoke=async(method,p,body)=>{if(method==='PUT'){puts++;f.scripts.put(scope,{title:'并行修改',content:'保留',expected_revision:0});}return f.invoke(method,p,body);};
 await assert.rejects(cap.execute(scope,{operationId:'scripts.save',args:{title:'覆写',content:'x',expected_revision:0}},{allowWrites:true,invoke}),e=>e.status===409);assert.equal(puts,1);assert.equal(f.scripts.get(scope).title,'并行修改');
 const controller=new AbortController();const aborted=async(method,p,body)=>{const result=await f.invoke(method,p,body);controller.abort();return result;};
 await assert.rejects(cap.execute(scope,{operationId:'scripts.save',args:{title:'覆写',content:'x',expected_revision:1}},{allowWrites:true,invoke:aborted,signal:controller.signal}),/中止/);assert.equal(f.scripts.get(scope).title,'并行修改');
});
test('global template save through existing router validates schema/version chain, project writes rejected',async t=>{
 const f=await fixture(t),template=f.templates.create({name:'模板',body:'Hello {{name}}',fields:[{key:'name',type:'text',required:true}]});assert.equal((await f.run(f.a.id,'templates.list')).items[0].id,template.id);
 const definition={...template.definition,body:'Changed {{name}}'};const saved=await f.run('global','templates.save',{id:template.id,expected_revision:1,definition},{allowWrites:true});assert.equal(saved.current_version,2);assert.equal(saved.definition.body,definition.body);
 await assert.rejects(f.run('global','templates.save',{id:template.id,expected_revision:1,definition},{allowWrites:true}),e=>e.status===409);assert.equal(f.templates.versions(template.id).length,2);
 await assert.rejects(f.run('global','templates.save',{id:template.id,expected_revision:2,definition:{...definition,fields:[{...definition.fields[0],unknown:true}]}},{allowWrites:true}),/未知参数/);
});
test('material query encoding, bounded result and read-only video status use actual paths',async t=>{
 const f=await fixture(t);const q='雨 & /api/evil';await f.run('global','materials.search',{q,kind:'sfx',page:1,pageSize:20});const p=f.calls.at(-1).path;assert.equal(new URL('http://local'+p).searchParams.get('q'),q);assert.equal((await f.run('global','materials.read',{id:f.media})).id,f.media);assert.equal((await f.run(f.a.id,'videos.state')).projectId,f.a.id);
 await assert.rejects(cap.execute('global',{operationId:'materials.search',args:{}},{invoke:async()=>({blob:'a'.repeat(1024*1024)})}),/结果超过/);
 for(const operationId of ['database.query','files.move','models.generate','service.stop','accounts.read','templates.delete'])await assert.rejects(f.run('global',operationId),/没有该能力/);
});
