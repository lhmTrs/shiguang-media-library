import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {once} from 'node:events';
import {fixture,uid} from './helpers/project-render-fixture.mjs';
import {projectRenderRouter} from '../server/project-renders.mjs';
test('schema2 read-only summary and original durable schema failure returned as 200 failed; same ID replay and conflict preserved',{timeout:15000},async t=>{
 const f=await fixture(t);f.lib.db.exec('ALTER TABLE project_renders DROP COLUMN revision');
 const app=express();app.use('/api/projects/:projectId/timelines/:timelineId/render',projectRenderRouter(f.renders));const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));
 const url='http://127.0.0.1:'+server.address().port+`/api/projects/${f.project.id}/timelines/${f.timelineId}/render`;
 const read=await fetch(url+'?schema=2');const dto=await read.json();assert.equal(read.status,200);assert.equal(dto.writable,false);assert.equal(dto.details.renderSchemaUpgrade.state,'required');assert.equal(dto.link,null);assert.equal(f.lib.db.prepare('PRAGMA table_info(project_renders)').all().length,3);
 assert.equal(await (await fetch(url)).json(),null);
 const input={requestId:uid(),expectedRevision:0};const send=body=>fetch(url,{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const response=await send(input),failed=await response.json();assert.equal(response.status,200);assert.equal(failed.status,'failed');assert.equal(failed.error.code,'RENDER_SCHEMA_MIGRATION_REQUIRED');assert.equal(failed.error.details.renderSchemaUpgrade.state,'required');
 assert.deepEqual(await (await send(input)).json(),failed);assert.deepEqual(await (await fetch(url+'/requests/'+input.requestId)).json(),failed);
 assert.equal((await send({...input,expectedRevision:1})).status,409);
 const stored=JSON.parse(f.lib.db.prepare('SELECT data_json FROM project_video_operations WHERE id=?').get(input.requestId).data_json);assert.equal(stored.status,'failed');assert.equal(stored.action,'render-unlink');
});
test('failed journal persistence cannot be recast as schema failed terminal receipt',{timeout:15000},async t=>{
 const f=await fixture(t);f.lib.db.exec('ALTER TABLE project_renders DROP COLUMN revision');const j=f.catalog.usageJournal,original=j.save.bind(j);j.save=()=>{throw Error('synthetic journal persistence unavailable');};
 const input={requestId:uid(),expectedRevision:0};await assert.rejects(f.renders.remove(f.project.id,f.timelineId,input),/synthetic journal persistence unavailable/);await j.settle();assert.notEqual(f.renders.request(f.project.id,f.timelineId,input.requestId).status,'failed');j.save=original;
});
