// 待处理 · 轮询链去重（src/notices/poll.ts）。假定时器 + 多次 visibilitychange，不起服务、不开浏览器。
// 运行：node --test tests/notices-poll.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sg-notices-poll-'));
test.after(() => fs.rm(temp, {recursive: true, force: true}));
const source = await fs.readFile(path.join(root, 'src', 'notices', 'poll.ts'), 'utf8');
await fs.writeFile(path.join(temp, 'poll.mjs'), ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022}}).outputText);
const {startPolling} = await import(path.join(temp, 'poll.mjs'));

/** 假环境：手动推进的定时器、可控的「隐藏」状态、可控的请求（每次 run 返回一个要手动结束的 promise）。 */
function fakeEnv() {
  const timers = new Map(); let nextId = 1, hidden = false, listener = null;
  const env = {
    hidden: () => hidden,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, {fn, ms}); return id; },
    clearTimer: id => { timers.delete(id); },
    onVisible: fn => { listener = fn; return () => { listener = null; }; },
  };
  const calls = []; let inflight = 0, maxInflight = 0;
  const run = () => { inflight++; maxInflight = Math.max(maxInflight, inflight); let done; const p = new Promise(r => { done = r; }); calls.push(() => { inflight--; done(); }); return p; };
  const flush = () => new Promise(r => setImmediate(r));
  return {
    env, run, calls, timers,
    chains: () => timers.size + inflight,
    get maxInflight() { return maxInflight; },
    setHidden: v => { hidden = v; },
    visible: () => { hidden = false; listener?.(); },
    finish: async () => { calls.shift()?.(); await flush(); await flush(); },
    fire: async () => { const [id, t] = [...timers][0]; timers.delete(id); t.fn(); await flush(); },
    flush,
  };
}

test('请求进行中多次变回可见：不多发请求，读完只排一个定时器', async () => {
  const f = fakeEnv();
  const stop = startPolling(f.run, 30_000, f.env);
  assert.equal(f.calls.length, 1, '一开始马上读一次');
  for (let i = 0; i < 5; i++) { f.setHidden(true); f.visible(); assert.ok(f.chains() <= 1, `第 ${i + 1} 次 visibilitychange 后有 ${f.chains()} 条链`); }
  assert.equal(f.calls.length, 1, '请求还没回来时变回可见不另发请求');
  await f.finish();
  assert.equal(f.timers.size, 1);
  assert.equal(f.chains(), 1);
  stop();
});

test('等下一次的时候变回可见：取消定时器、马上读一次；连着来几次也只有一条链', async () => {
  const f = fakeEnv();
  const stop = startPolling(f.run, 30_000, f.env);
  await f.finish();
  for (let round = 0; round < 3; round++) {
    assert.equal(f.timers.size, 1);
    for (let i = 0; i < 4; i++) { f.setHidden(true); f.visible(); assert.ok(f.chains() <= 1, `第 ${round + 1} 轮第 ${i + 1} 次后有 ${f.chains()} 条链`); }
    assert.equal(f.timers.size, 0, '定时器已取消');
    await f.finish();
    assert.equal(f.chains(), 1);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.maxInflight, 1, '任何时候最多一个请求在进行');
  // 定时器正常到点：读一次，再排一次
  await f.fire(); assert.equal(f.chains(), 1); await f.finish(); assert.equal(f.timers.size, 1);
  stop();
});

test('隐藏时不发请求，照常排下一次；停止后进行中的请求回来也不再排', async () => {
  const f = fakeEnv();
  f.setHidden(true);
  const stop = startPolling(f.run, 10_000, f.env);
  assert.equal(f.calls.length, 0);
  assert.equal(f.timers.size, 1);
  await f.fire(); await f.fire();
  assert.equal(f.calls.length, 0, '隐藏时到点也不读');
  f.visible();
  assert.equal(f.calls.length, 1);
  stop();
  await f.finish();
  assert.equal(f.chains(), 0, '停止后不留定时器');
  f.visible();
  assert.equal(f.calls.length, 0, '停止后不再响应 visibilitychange');
});

test('对照：旧写法在请求进行中变回可见会多出一条链（证明上面的测试能抓到这个问题）', async () => {
  const f = fakeEnv();
  // 旧的 NoticesEntry 轮询（PR #139 的 119–129 行），换成假环境
  let timer, stopped = false;
  const tick = async () => { if (!f.env.hidden()) await f.run(); if (!stopped) timer = f.env.setTimer(tick, 30_000); };
  void tick();
  f.env.onVisible(() => { if (!f.env.hidden()) { f.env.clearTimer(timer); void tick(); } });
  f.visible();
  await f.finish(); await f.finish();
  assert.equal(f.timers.size, 2, '旧写法：两条链');
  stopped = true;
});
