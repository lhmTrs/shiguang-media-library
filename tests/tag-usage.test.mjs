import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';

const source = await fs.readFile(new URL('../src/tag-usage.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const usage = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));

test('browser tag usage: per-tag ten-second counting, persistence and ranking', () => {
  const store = new Map();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) } });
  try {
    usage.recordTagUse('悬疑', 100_000);
    usage.recordTagUse('恐怖', 101_000);
    usage.recordTagUse('悬疑', 109_999);
    assert.equal(usage.readTagUsage()['悬疑'].count, 1);
    assert.equal(usage.readTagUsage()['恐怖'].count, 1);
    assert.equal(usage.readTagUsage()['悬疑'].lastUsed, 109_999);
    usage.recordTagUse('悬疑', 110_000);
    assert.equal(usage.readTagUsage()['悬疑'].count, 2);
    assert.deepEqual(['恐怖', '未知', '悬疑'].sort((a, b) => usage.compareTagUsage(usage.readTagUsage(), a, b)), ['悬疑', '恐怖', '未知']);
    assert.equal(JSON.parse(store.get(usage.TAG_USAGE_KEY)).tags['悬疑'].count, 2);
    usage.recordTagUse('__proto__', 110_001);
    usage.recordTagUse('constructor', 110_002);
    assert.equal(usage.readTagUsage()['__proto__'].count, 1);
    assert.equal(usage.readTagUsage()['constructor'].count, 1);
    assert.equal(Object.getPrototypeOf(usage.readTagUsage()), null);
    store.set(usage.TAG_USAGE_KEY, '{broken');
    assert.deepEqual(Object.keys(usage.readTagUsage()), []);
    usage.recordTagUse('恢复', 200_000);
    assert.equal(usage.readTagUsage()['恢复'].count, 1);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  }
});

test('browser tag usage tolerates invalid data and unavailable storage', () => {
  for (const raw of [null, '[]', '{"version":2,"tags":{}}', '{"version":1,"tags":{"bad":{"count":-1}}}']) assert.equal(Object.keys(usage.parseTagUsage(raw)).length, 0);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw Error('Storage blocked'); } });
  try {
    assert.doesNotThrow(() => usage.recordTagUse('内存回退', 300_000));
    usage.recordTagUse('内存回退', 300_001);
    assert.equal(usage.readTagUsage()['内存回退'].count, 1);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  }
});
