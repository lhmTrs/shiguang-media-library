/**
 * T-LOCAL-012 round3：在 GPT probe-lock-race.mjs 基础上按“不自动回收”安全契约调整的回归探针。
 *
 * 原探针在最终 owner 校验之后注入 rename 交错，期望回收者保留替换后的活锁。round3 选择
 * fail-closed：任何已存在的锁都 BUSY，不在运行期 rename/删除，原注入点因此不可达。
 * 本探针保留同一核心断言：替换后的活 owner 必须保留、不得产生 stale 搬移、安装不得成功。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { AudioEngine, AudioEngineError } from '../../../../server/audio-engine.mjs';
import { tempDir, makeTlsFixture, startTlsServer, makeTar, makeRelease, waitForJob } from '../../../../tests/audio-engine-fixtures.mjs';

test('fail-closed 回收契约：替换后的活 owner 保留且安装 BUSY', async (t) => {
  const dataDir = await tempDir(t);
  const tls = await makeTlsFixture(t);
  const archive = await makeTar([{ name: 'audio-analyze', data: Buffer.from('synthetic-not-executable') }]);
  const server = await startTlsServer(t, tls, (_req, res) => {
    res.writeHead(200, { 'content-length': archive.length });
    res.end(archive);
  });
  const lock = path.join(dataDir, 'engines', '.audio-install.lock');
  await fs.mkdir(lock, { recursive: true });
  await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647, token: 'dead-owner' }));

  const engine = new AudioEngine(dataDir, { release: makeRelease(archive, server.url), ca: tls.ca, diskFreeBytes: 1e9 });
  t.after(() => engine.dispose());

  // 另一个进程在“观察到死 owner”之后换入自己的活锁。
  await fs.rename(lock, path.join(dataDir, 'dead-lock-backup'));
  await fs.mkdir(lock);
  await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'replacement-live-owner' }));

  const rename = fs.rename;
  let staleAttempt = null;
  fs.rename = async (from, to) => {
    if (from === lock && String(to).includes('.stale-')) staleAttempt = { from, to };
    return rename(from, to);
  };
  t.after(() => { fs.rename = rename; });

  assert.throws(
    () => engine.install({ confirm: true }),
    (error) => error instanceof AudioEngineError && error.code === 'ENGINE_BUSY',
  );
  assert.equal(staleAttempt, null, '不得尝试 stale rename');
  const owner = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8'));
  assert.equal(owner.token, 'replacement-live-owner');
  assert.equal((await fs.readdir(path.join(dataDir, 'engines'))).some((name) => name.includes('.stale-')), false);

  // 安全契约下不应产生安装任务；若引擎内部已创建任务，也必须不是 installed。
  const status = engine.status();
  assert.equal(status.installed, false);
  assert.equal(fssync.existsSync(path.join(dataDir, 'engines', 'current.json')), false);
  await fs.rm(lock, { recursive: true, force: true });
});

