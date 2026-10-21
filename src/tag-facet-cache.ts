export const TAG_FACET_CACHE_KEY = "shiguang.tagFacetCache.v1";
export type TagFacet = { id: string; name: string; n: number; total: number };
export type TagFacets = { revision: string; total: number; items: TagFacet[] };
type Cache = { version: 1; revision: string; entries: { key: string; value: TagFacets; saved: number }[] };
type Request = <T>(url: string) => Promise<T>;
let generation = 0;

export function clearTagFacetCache(): void {
  generation++;
  try { localStorage.removeItem(TAG_FACET_CACHE_KEY); } catch {}
}

export function tagFacetKey(params: URLSearchParams): string {
  const normalized = new URLSearchParams(params);
  normalized.delete("page"); normalized.delete("sort"); normalized.delete("pageSize");
  for (const key of ["root", "tagRules"]) {
    if (key === "root") {
      const roots = [...new Set(normalized.getAll(key))].sort(); normalized.delete(key);
      roots.forEach(root => normalized.append(key, root));
    } else if (normalized.has(key)) {
      try {
        const rules = JSON.parse(normalized.get(key)!);
        normalized.set(key, JSON.stringify(Object.fromEntries(["all", "any", "none"].map(mode => [mode, [...new Set(rules[mode] || [])].sort()]))));
      } catch {}
    }
  }
  normalized.sort(); return normalized.toString();
}

function validValue(value: TagFacets, revision: string): boolean {
  return value?.revision === revision && Number.isSafeInteger(value.total) && value.total >= 0 && Array.isArray(value.items)
    && value.items.every(t => typeof t.id === "string" && typeof t.name === "string" && Number.isSafeInteger(t.n) && t.n >= 0 && Number.isSafeInteger(t.total) && t.total >= t.n);
}
function readCache(revision: string): Cache {
  try {
    const cache = JSON.parse(localStorage.getItem(TAG_FACET_CACHE_KEY) || "null");
    if (cache?.version === 1 && cache.revision === revision && Array.isArray(cache.entries) && cache.entries.length <= 24
      && cache.entries.every((e: Cache["entries"][number]) => e && typeof e.key === "string" && Number.isFinite(e.saved) && validValue(e.value, revision))) return cache;
    localStorage.removeItem(TAG_FACET_CACHE_KEY);
  } catch {}
  return { version: 1, revision, entries: [] };
}

export async function loadTagFacets(params: URLSearchParams, request: Request): Promise<TagFacets> {
  const epoch = generation, key = tagFacetKey(params);
  // Validate the version even on a browser cache hit: external API edits and scans count too.
  const { revision } = await request<{ revision: string }>("/tags/revision");
  const cache = readCache(revision), cached = cache.entries.find(e => e.key === key && Date.now() - e.saved < 600_000);
  if (cached && generation === epoch) return cached.value;
  const value = await request<TagFacets>("/tags/facets?" + key);
  if (generation === epoch && validValue(value, value.revision)) {
    const latest = readCache(value.revision);
    const entries = [{ key, value, saved: Date.now() }, ...latest.entries.filter(e => e.key !== key)].slice(0, 24);
    // Keep browser storage bounded; if unavailable, simply fetch next time.
    while (entries.length && JSON.stringify(entries).length > 750_000) entries.pop();
    try { localStorage.setItem(TAG_FACET_CACHE_KEY, JSON.stringify({ version: 1, revision: value.revision, entries })); } catch { try { localStorage.removeItem(TAG_FACET_CACHE_KEY); } catch {} }
  }
  return value;
}
