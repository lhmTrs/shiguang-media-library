import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';
const source = await fs.readFile(new URL('../src/tag-facet-cache.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const cache = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));

test('browser facets: batch cache, canonical keys, data revisions and local invalidation', async () => {
  const store = new Map(), previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) } });
  try {
    let revision = 'database-A:1', facets = 0, current = 12;
    const request = async url => {
      if (url === '/tags/revision') return { revision };
      facets++;
      return { revision, total: current, items: [{ id: 'cute', name: '可爱', n: current, total: 100 }] };
    };
    const params = new URLSearchParams({ kind: 'sfx', tagRules: JSON.stringify({ all: ['悬疑'], any: [], none: [] }) });
    assert.equal((await cache.loadTagFacets(params, request)).items[0].n, 12);
    await cache.loadTagFacets(params, request); assert.equal(facets, 1);
    const anotherPage = new URLSearchParams(params); anotherPage.set('page', '3'); anotherPage.set('sort', 'name');
    await cache.loadTagFacets(anotherPage, request); assert.equal(facets, 1);
    current = 10; revision = 'database-A:2';
    assert.equal((await cache.loadTagFacets(params, request)).items[0].n, 10); assert.equal(facets, 2);
    assert.equal(JSON.parse(store.get(cache.TAG_FACET_CACHE_KEY)).entries.length, 1);
    cache.clearTagFacetCache(); assert.equal(store.has(cache.TAG_FACET_CACHE_KEY), false);
    await cache.loadTagFacets(params, request); assert.equal(facets, 3);
    const all = new URLSearchParams({ kind: 'sfx' });
    await cache.loadTagFacets(all, request); assert.equal(facets, 4);
    await cache.loadTagFacets(params, request); assert.equal(facets, 4);
    revision = 'different-database:1'; await cache.loadTagFacets(params, request); assert.equal(facets, 5);
    store.set(cache.TAG_FACET_CACHE_KEY, '{broken'); await cache.loadTagFacets(params, request); assert.equal(facets, 6);
    const reversed = new URLSearchParams('root=b&root=a&tagRules=' + encodeURIComponent(JSON.stringify({ all: ['可爱', '悬疑'] })));
    const sorted = new URLSearchParams('root=a&root=b&tagRules=' + encodeURIComponent(JSON.stringify({ all: ['悬疑', '可爱'], any: [], none: [] })));
    assert.equal(cache.tagFacetKey(reversed), cache.tagFacetKey(sorted));
    for (let i=0; i<30; i++) await cache.loadTagFacets(new URLSearchParams({ q: String(i) }), request);
    assert.equal(JSON.parse(store.get(cache.TAG_FACET_CACHE_KEY)).entries.length, 24);
    cache.clearTagFacetCache();
    let release; const blocked = new Promise(resolve => release = resolve);
    const pending = cache.loadTagFacets(params, async url => {
      if (url === '/tags/revision') return { revision };
      await blocked; return { revision, total: 1, items: [] };
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    cache.clearTagFacetCache(); release(); await pending;
    assert.equal(store.has(cache.TAG_FACET_CACHE_KEY), false, 'stale in-flight request must not repopulate invalidated cache');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage;
  }
});

test('browser facets still load with blocked localStorage', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw Error('blocked'); } });
  try {
    const result = await cache.loadTagFacets(new URLSearchParams(), async url => url === '/tags/revision' ? { revision: 'r1' } : { revision: 'r1', total: 0, items: [] });
    assert.equal(result.total, 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage;
  }
});
