import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import express from 'express';
import {projectVideoRouter} from '../server/project-videos/router.mjs';
import {fixture, imported, initialize, bind} from './helpers/project-video-desktop-fixture.mjs';

async function setup(t) {
  const f = await fixture(t);
  initialize(f);
  const projectId = f.project.id;
  const folder = await f.catalog.folders.create(projectId, {requestId:randomUUID(), name:'目标', parentId:'root'});
  const videos = [await imported(f, 'a.mp4'), await imported(f, 'b.mp4')];
  await bind(f, videos[0], [0]);
  const before = await f.entry.store.state(projectId);
  const app = express();
  app.use('/api/project-videos', projectVideoRouter(f.catalog));
  app.use((error, _req, res, _next) => res.status(error.status ?? 500).json({code:error.code, error:error.message}));
  const server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  async function request(route, body, project = projectId) {
    const base = `http://127.0.0.1:${server.address().port}/api/project-videos/projects/${project}`;
    const response = await fetch(base + route, {
      ...(body === undefined ? {} : {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body),
      }),
    });
    return {status:response.status, body:await response.json()};
  }
  const input = {
    requestId:randomUUID(),
    kind:'move-videos',
    sourceIds:videos.map(video => video.id),
    destinationFolderId:folder.id,
    expectedRolesRevision:f.catalog.folders.roleState(projectId).revision,
  };
  const preview = await request('/operations/preview', input);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.ready, true);
  const execute = {
    requestId:input.requestId, previewHash:preview.body.previewHash,
    confirmUnbind:true, confirmedUnbindShotIds:[],
  };
  return {f, projectId, folder, videos, before, input, execute, request, route:'/operations/' + input.requestId};
}

test('abandoned batch stays cancelled on GET and refuses late execute or rollback without touching files or shots', async t => {
  const {f, projectId, folder, videos, before, input, execute, request, route} = await setup(t);
  assert.equal((await request(route)).body.errorCode, 'OPERATION_NOT_STARTED');
  const crossProject = await request(route + '/abandon', {}, f.other.id);
  assert.equal(crossProject.status, 404);
  assert.equal(crossProject.body.code, 'OPERATION_NOT_FOUND');
  assert.equal((await request(route + '/recover', {action:'rollback'})).body.code, 'OPERATION_NOT_STARTED');

  const cancelled = {
    requestId:input.requestId, status:'cancelled', phase:'preview',
    errorCode:'OPERATION_ABANDONED', canRecover:false,
  };
  // Discard the first acknowledgement and read the durable outcome via GET.
  assert.equal((await request(route + '/abandon', {})).status, 200);
  assert.deepEqual(await request(route), {status:200, body:cancelled});
  assert.deepEqual(await request(route + '/abandon', {}), {status:200, body:cancelled});
  for (const [endpoint, payload] of [
    ['/operations', execute],
    [route + '/recover', {action:'rollback'}],
    ['/operations/preview', input],
  ]) {
    const rejected = await request(endpoint, payload);
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.code, 'OPERATION_ABANDONED');
  }
  const fresh = await request('/operations/preview', {...input, requestId:randomUUID()});
  assert.equal(fresh.status, 200);
  const oldHash = await request('/operations', {...execute, requestId:fresh.body.requestId});
  assert.equal(oldHash.status, 409);
  assert.equal(oldHash.body.code, 'PREVIEW_REQUIRED');
  assert.deepEqual(await fs.readdir(folder.path), []);
  for (const video of videos) {
    assert.deepEqual(await fs.readFile(video.path), f.bytes);
    assert.equal(f.entry.store.source(projectId, video.id).path, video.path);
  }
  const after = await f.entry.store.state(projectId);
  assert.deepEqual(after.plan, before.plan);
  assert.deepEqual(after.shots, before.shots);
});

test('execution that registers first keeps the same operation and its actual result', async t => {
  const {f, projectId, folder, videos, before, execute, request, route} = await setup(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const gateWork = f.catalog.serial(() => gate);
  t.after(release);
  try {
    const started = await request('/operations', execute);
    assert.equal(started.status, 200);
    assert.equal(started.body.status, 'running');
    assert.deepEqual(await request(route + '/abandon', {}), started);
    assert.deepEqual(await request('/operations', execute), started);
  } finally {
    release();
    await gateWork;
  }
  await f.catalog.queue;
  const done = await request(route);
  assert.equal(done.body.status, 'ready', done.body.error);
  assert.deepEqual(await request(route + '/abandon', {}), done);
  for (const video of videos) {
    const file = f.entry.store.source(projectId, video.id).path;
    assert.equal(path.dirname(file), folder.path);
    assert.deepEqual(await fs.readFile(file), f.bytes);
    await assert.rejects(fs.access(video.path), {code:'ENOENT'});
  }
  assert.deepEqual((await f.entry.store.state(projectId)).plan, before.plan);
});

test('abandon is scoped to ordinary batch moves', async t => {
  const {f, folder, videos, input, request} = await setup(t);
  const role = await request('/folders/reject/preview', {
    requestId:randomUUID(), folderId:folder.id, expectedRolesRevision:input.expectedRolesRevision,
  });
  assert.equal(role.status, 200);
  const single = await request('/operations/preview', {
    requestId:randomUUID(), kind:'move-video', sourceId:videos[0].id, destinationFolderId:folder.id,
  });
  assert.equal(single.status, 200);
  const rejectMove = await request('/operations/preview', {...input, requestId:randomUUID(), unbindAdoptions:true});
  assert.equal(rejectMove.status, 200);
  for (const {body:{requestId}} of [role, single, rejectMove]) {
    const rejected = await request(`/operations/${requestId}/abandon`, {});
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.code, 'INVALID_OPERATION');
    assert.equal(f.catalog.fileOperations.row(f.project.id, requestId).status, 'preview');
  }
});
