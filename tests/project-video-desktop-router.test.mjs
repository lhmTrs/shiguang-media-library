import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {fixture,imported,finish,replaceBytes} from './helpers/project-video-desktop-fixture.mjs';
import {projectVideoRouter} from '../server/project-videos/router.mjs';

test('real loopback HTTP router: capability/202/GET, lost-response replay, session guard and controlled changed-media FD release',async t=>{
  const f=await fixture(t),source=await imported(f),app=express();
  app.use((req,res,next)=>req.headers['x-owned-test-session']==='yes'?next():res.status(403).json({code:'SESSION_REQUIRED'}));
  app.use('/api/project-videos',projectVideoRouter(f.catalog,{sendMedia:async(_req,res,_file,handle)=>res.end(await handle.readFile())}));
  const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  const base=`http://127.0.0.1:${server.address().port}/api/project-videos/projects/${f.project.id}`;
  const request=(suffix='',input)=>fetch(base+suffix,{method:input?'POST':'GET',headers:{'x-owned-test-session':'yes','content-type':'application/json','x-forwarded-for':'203.0.113.1'},...(input?{body:JSON.stringify(input)}:{})});
  assert.equal((await fetch(base)).status,403);
  const list=await (await request()).json();assert.equal(list.capabilities.clipboard.available,true);assert.equal(list.capabilities.maxSelection,50);
  const args={requestId:randomUUID(),ids:[source.id]},initial=await request('/videos/clipboard',args);assert.equal(initial.status,202);const receipt=await finish(f,await initial.json());assert.equal(receipt.count,1);
  const repeated=await request('/videos/clipboard',args);assert.equal(repeated.status,200);assert.deepEqual(await repeated.json(),receipt);assert.equal(f.native.copies.length,1);
  const result=await request('/desktop-actions/'+args.requestId);assert.deepEqual(await result.json(),receipt);
  await replaceBytes(f,source);
  const p=await finish(f,await (await request(`/videos/${source.id}/changes/preview`,{requestId:randomUUID(),expectedRevision:1})).json());assert.equal(p.status,'ready');
  const candidate=await request(`/videos/${source.id}/changes/${p.contentToken}/media`);assert.equal(candidate.status,200);assert.ok((await candidate.arrayBuffer()).byteLength>0);
  await new Promise(r=>setTimeout(r,20));assert.equal(f.entry.media.handles.size,0);assert.equal(f.entry.media.responses.size,0);
  const normal=await request(`/videos/${source.id}/media`);assert.equal(normal.status,409);assert.equal((await normal.json()).code,'SOURCE_CHANGED');
});

test('router rejects non-loopback peer regardless of forwarded-for before native work',async t=>{
  const f=await fixture(t),source=await imported(f),router=projectVideoRouter(f.catalog);
  const route=router.stack.find(s=>s.route?.path==='/projects/:projectId/videos/clipboard').route.stack[0].handle;
  let error;route({socket:{remoteAddress:'203.0.113.2'},headers:{'x-forwarded-for':'127.0.0.1'},params:{projectId:f.project.id},body:{requestId:randomUUID(),ids:[source.id]}},{},e=>{error=e;});
  await new Promise(r=>setImmediate(r));assert.equal(error.code,'DESKTOP_LOCAL_ONLY');assert.equal(f.native.copies.length,0);
});
