import React from 'react';

/*
 * 剧本正文的 Markdown 阅读视图：只认常用写法（标题、加粗、斜体、行内代码、列表、引用、分隔线、代码块）。
 * - 一律当文字渲染，不用 innerHTML；网页代码、链接和图片都原样显示成文字，不会加载外部资源。
 * - 剧本里每一行都有意义，所以同一段内的换行保留为换行（不像标准 Markdown 那样并成一行）。
 * - 每个块带上原文的行号（data-line），场次大纲在阅读状态下按行号滚到对应位置。
 */

export type ScriptHeading = { line: number; offset: number; text: string };

const headingRe = /^\s{0,3}(#{1,4})\s+(.*?)\s*#*\s*$/;
const numberedRe = /^\s*\d+[.．、]\s*\S/;
const ruleRe = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const quoteRe = /^\s{0,3}>\s?/;
const bulletRe = /^\s{0,3}[-*+]\s+/;
const orderedRe = /^\s{0,3}(\d{1,9})[.)]\s+/;
const fenceRe = /^\s{0,3}```/;

/** 场次大纲：「## 标题」和原来的「1. 场一」都算。 */
export function scriptOutline(text: string): ScriptHeading[] {
  const out: ScriptHeading[] = []; let offset = 0, fenced = false;
  text.split('\n').forEach((l, i) => {
    if (fenceRe.test(l)) fenced = !fenced;
    else if (!fenced) {
      const h = l.match(headingRe);
      if (h && h[2]) out.push({ line: i, offset, text: h[2].trim() });
      else if (numberedRe.test(l)) out.push({ line: i, offset, text: l.trim() });
    }
    offset += l.length + 1;
  });
  return out.slice(0, 300);
}

/** 行内：**加粗**、*斜体*、`代码`；其余全部是文字。 */
export function Inline({ text }: { text: string }) {
  const parts: React.ReactNode[] = []; const re = /(\*\*[^*\n]+?\*\*|`[^`\n]+`|\*[^*\s][^*\n]*?\*)/g; let last = 0;
  for (const m of text.matchAll(re)) {
    const v = m[0], at = m.index!;
    parts.push(text.slice(last, at));
    parts.push(v.startsWith('**') ? <strong key={at}>{v.slice(2, -2)}</strong> : v.startsWith('`') ? <code key={at}>{v.slice(1, -1)}</code> : <em key={at}>{v.slice(1, -1)}</em>);
    last = at + v.length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

type Block =
  | { kind: 'heading'; level: number; line: number; text: string }
  | { kind: 'rule'; line: number }
  | { kind: 'code'; line: number; lines: string[] }
  | { kind: 'quote'; line: number; lines: string[] }
  | { kind: 'list'; ordered: boolean; start: number; line: number; items: { line: number; text: string }[] }
  | { kind: 'para'; line: number; lines: string[] };

export function parseScript(text: string): Block[] {
  const lines = text.split('\n'), blocks: Block[] = []; let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (fenceRe.test(l)) {
      const start = i, body: string[] = []; i++;
      while (i < lines.length && !fenceRe.test(lines[i])) body.push(lines[i++]);
      i++; blocks.push({ kind: 'code', line: start, lines: body }); continue;
    }
    const h = l.match(headingRe);
    if (h && h[2]) { blocks.push({ kind: 'heading', level: h[1].length, line: i, text: h[2] }); i++; continue; }
    if (ruleRe.test(l)) { blocks.push({ kind: 'rule', line: i }); i++; continue; }
    if (quoteRe.test(l)) {
      const start = i, body: string[] = [];
      while (i < lines.length && quoteRe.test(lines[i])) body.push(lines[i++].replace(quoteRe, ''));
      blocks.push({ kind: 'quote', line: start, lines: body }); continue;
    }
    const ordered = orderedRe.test(l);
    if (ordered || bulletRe.test(l)) {
      const re = ordered ? orderedRe : bulletRe, start = i, items: { line: number; text: string }[] = [];
      while (i < lines.length && re.test(lines[i])) { items.push({ line: i, text: lines[i].replace(re, '') }); i++; }
      blocks.push({ kind: 'list', ordered, start: ordered ? Number(l.match(orderedRe)![1]) : 1, line: start, items }); continue;
    }
    const start = i, body: string[] = [];
    while (i < lines.length && lines[i].trim() && !fenceRe.test(lines[i]) && !headingRe.test(lines[i]) && !ruleRe.test(lines[i]) && !quoteRe.test(lines[i]) && !orderedRe.test(lines[i]) && !bulletRe.test(lines[i])) body.push(lines[i++]);
    blocks.push({ kind: 'para', line: start, lines: body });
  }
  return blocks;
}

const withBreaks = (lines: string[]) => lines.map((t, i) => <React.Fragment key={i}>{i > 0 && <br />}<Inline text={t} /></React.Fragment>);

export function ScriptMarkdown({ text }: { text: string }) {
  const blocks = React.useMemo(() => parseScript(text), [text]);
  return <div className="ca-script-md">{blocks.map(b => {
    const key = b.kind + b.line;
    if (b.kind === 'heading') { const Tag = (['h3', 'h4', 'h5', 'h6'] as const)[b.level - 1]; return <Tag key={key} data-line={b.line} className={'ca-md-h' + b.level}><Inline text={b.text} /></Tag>; }
    if (b.kind === 'rule') return <hr key={key} data-line={b.line} />;
    if (b.kind === 'code') return <pre key={key} data-line={b.line}><code>{b.lines.join('\n')}</code></pre>;
    if (b.kind === 'quote') return <blockquote key={key} data-line={b.line}>{withBreaks(b.lines)}</blockquote>;
    if (b.kind === 'list') { const items = b.items.map(it => <li key={it.line} data-line={it.line}><Inline text={it.text} /></li>); return b.ordered ? <ol key={key} start={b.start}>{items}</ol> : <ul key={key}>{items}</ul>; }
    return <p key={key} data-line={b.line}>{withBreaks(b.lines)}</p>;
  })}</div>;
}
