export const TAG_USAGE_KEY = "shiguang.tagFilterUsage.v1";
export type TagUsage = Record<string, { count: number; lastUsed: number; lastCounted: number }>;
let memory: TagUsage = Object.create(null);

export function parseTagUsage(raw: string | null): TagUsage {
  const result: TagUsage = Object.create(null);
  try {
    const data = JSON.parse(raw || "null");
    if (data?.version !== 1 || !data.tags || typeof data.tags !== "object" || Array.isArray(data.tags)) return result;
    for (const [name, item] of Object.entries(data.tags).slice(0, 5000)) {
      const v = item as TagUsage[string] | null;
      if (!name || name.length > 200 || !v || !Number.isSafeInteger(v.count) || v.count < 1 || !Number.isSafeInteger(v.lastUsed) || v.lastUsed < 0 || !Number.isSafeInteger(v.lastCounted) || v.lastCounted < 0) continue;
      result[name] = { count: v.count, lastUsed: v.lastUsed, lastCounted: v.lastCounted };
    }
  } catch {}
  return result;
}

export function readTagUsage(): TagUsage {
  try { memory = parseTagUsage(localStorage.getItem(TAG_USAGE_KEY)); } catch {}
  return memory;
}

export function recordTagUse(name: string, now = Date.now()): void {
  const usage: TagUsage = Object.assign(Object.create(null), readTagUsage()), previous = usage[name];
  const increment = !previous || now < previous.lastCounted || now - previous.lastCounted >= 10_000;
  usage[name] = {
    count: Math.min(Number.MAX_SAFE_INTEGER, (previous?.count || 0) + (increment ? 1 : 0)),
    lastUsed: now,
    lastCounted: increment ? now : previous.lastCounted,
  };
  memory = usage;
  try { localStorage.setItem(TAG_USAGE_KEY, JSON.stringify({ version: 1, tags: usage })); } catch {}
}

export function compareTagUsage(usage: TagUsage, a: string, b: string): number {
  return (usage[b]?.count || 0) - (usage[a]?.count || 0)
    || (usage[b]?.lastUsed || 0) - (usage[a]?.lastUsed || 0)
    || a.localeCompare(b, "zh-CN");
}
