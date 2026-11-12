// 「整理旧项目」的分组建议（原型 ④）：按项目名规律把未分组项目归到同一部剧。只给建议，不改任何项目名。
import type { GroupedProject, Series } from './model';

export type NameParts = { base: string; episode: number | null; uncertain: boolean };

/** 「赤贫农夫养家计_54」→ 赤贫农夫养家计 / 54；「玫瑰的婚姻1-1」→ 玫瑰的婚姻 / 1（编号不确定）；没有结尾数字 → episode 为 null。 */
export function parseName(name: string): NameParts {
  const m = name.trim().match(/^(.*?)([\s_\-—·.]*(?:第\s*)?\d+\s*(?:集)?(?:[\s_\-—·.]+\d+)*)$/);
  if (!m || !m[1].trim()) return { base: name.trim(), episode: null, uncertain: false };
  const numbers = m[2].match(/\d+/g) ?? [];
  return { base: m[1].trim().replace(/[\s_\-—·.]+$/, ''), episode: Number(numbers.at(-1)), uncertain: numbers.length > 1 };
}
const key = (s: string) => s.replace(/\s+/g, '').toLowerCase();

export type SuggestionRow = { project: GroupedProject; episode_no: number; uncertain: boolean; checked: boolean };
export type Suggestion = { key: string; name: string; existing: Series | null; rows: SuggestionRow[] };

/**
 * 只看未分组项目。同一个前缀有 2 个以上项目，或前缀正好是已有剧名（1 个也算），就成为一组建议。
 * 已有剧：集号默认用名字里的数字；新剧同理；没有数字的按顺序补在后面。
 */
export function suggestGroups(ungrouped: GroupedProject[], series: Series[]): Suggestion[] {
  const buckets = new Map<string, { name: string; items: { p: GroupedProject; parts: NameParts }[] }>();
  for (const p of ungrouped) {
    const parts = parseName(p.name);
    if (parts.episode == null) continue;
    const k = key(parts.base); if (!k) continue;
    const b = buckets.get(k) ?? { name: parts.base, items: [] }; b.items.push({ p, parts }); buckets.set(k, b);
  }
  const out: Suggestion[] = [];
  for (const [k, b] of buckets) {
    const existing = series.find(s => key(s.name) === k) ?? null;
    if (b.items.length < 2 && !existing) continue;
    const rows = b.items.sort((a, z) => (a.parts.episode ?? 0) - (z.parts.episode ?? 0) || a.p.name.localeCompare(z.p.name, 'zh-CN'))
      .map(({ p, parts }) => ({ project: p, episode_no: parts.episode ?? 1, uncertain: parts.uncertain, checked: true }));
    out.push({ key: k, name: existing?.name ?? b.name, existing, rows });
  }
  return out.sort((a, z) => z.rows.length - a.rows.length || a.name.localeCompare(z.name, 'zh-CN'));
}
