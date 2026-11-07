import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStoryboardModule } from '../server/storyboard/router.mjs';
import { emptyProject } from '../server/storyboard/shared/model.mjs';

test('正常关闭拒绝新请求，但等待已经开始的分镜保存结清', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'storyboard-drain-'));
  const module = createStoryboardModule({ dataDir }), app = express();
  app.use('/api/storyboard', module.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/api/storyboard`;
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const original = module.store._save.bind(module.store);
  module.store._save = async (...args) => { started(); await gate; return original(...args); };
  const project = emptyProject();
  const save = fetch(base + '/projects/' + project.project_id, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project, expected_hash: null }) });
  await entered;
  let closed = false;
  const closing = module.close().then(() => { closed = true; });
  try {
    assert.equal((await fetch(base + '/workspace')).status, 503);
    assert.equal(closed, false);
  } finally { release(); }
  assert.equal((await save).status, 200);
  await closing;
  assert.equal(module.store.locks.size, 0);
  assert.deepEqual((await module.store.read(project.project_id)).project, project);
});
