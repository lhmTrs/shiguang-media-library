// 测试用：按合同 v1.1 的口径，把合成 graph + 合成来源文字拼成 renderData（服务器会做的事的最小替身）。
// 只用于前端测试的假回包；真正的校验和回填以后端为准。
import fs from 'node:fs';
import path from 'node:path';

const dir = path.dirname(new URL(import.meta.url).pathname);
export const readFixture = name => JSON.parse(fs.readFileSync(path.join(dir, name + '.json'), 'utf8'));

/** 合同的切行规则：去首 BOM，CRLF/CR 转 LF，单个末尾换行不增行。 */
export function splitLines(text) {
  const t = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = t.split('\n'); if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

export function makeRenderData(graph, { sourceTexts = readFixture('fixture_sources'), binding, deleted = [], at = Date.UTC(2026, 10, 24, 2, 30) } = {}) {
  const strip = refs => refs?.map(({ quote, ...r }) => r);
  const g = structuredClone(graph);
  for (const n of g.nodes) for (const k of ['refs', 'old', 'new']) if (n[k]) n[k] = strip(n[k]);
  const sources = graph.sources.map(s => ({ key: s.key, sourceId: s.sourceId, label: s.label || sourceTexts[s.sourceId]?.label || s.key, kind: 'snapshot', at, sourceState: deleted.includes(s.key) ? 'deleted' : 'available' }));
  const seen = new Map();
  for (const n of graph.nodes) for (const k of ['refs', 'old', 'new']) for (const r of n[k] || []) {
    const end = r.end ?? r.start, key = r.source + ':' + r.start + ':' + end; if (seen.has(key)) continue;
    const sid = graph.sources.find(s => s.key === r.source)?.sourceId, lines = splitLines(sourceTexts[sid]?.text ?? '');
    seen.set(key, { source: r.source, start: r.start, end, lines: lines.slice(r.start - 1, end).map((text, i) => ({ number: r.start + i, text })) });
  }
  const obj = (kind, id, displayLabel, when) => ({ kind, id, versionNo: null, title: '合成剧本', displayLabel, at: when });
  return {
    graph: g,
    binding: binding ?? (graph.kind === 'diff'
      ? { before: obj('snapshot', 'snap-1', '快照 #1', at - 86_400_000), target: obj('snapshot', 'snap-2', '快照 #2', at) }
      : { target: obj('snapshot', 'snap-1', '快照 #1', at) }),
    sources,
    excerpts: [...seen.values()],
  };
}
