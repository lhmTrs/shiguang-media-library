// 字号统一（UI 审计第二档）：全站字号只用 8 档，最小 11px。
// 用法：node tests/helpers/font-scale.mjs <css 文件...>  → 就地改写并打印每个文件 old→new 计数
//       node tests/helpers/font-scale.mjs --check <css 文件...>  → 只检查，不写
// 只改 font-size 的值和 font 简写里字号那一段（行高、粗细、字体族不动），不碰其他属性。
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/** 允许的字号档位；27、40 是大字特例（大头像字、占位大字），保留。 */
export const SCALE = [11, 12, 13, 14, 16, 18, 20, 24];
export const KEEP = [27, 40];
/** 用户批准的映射（2026-11-14「最小 11px」「按表来」）。 */
export const MAP = { 9: 11, 9.5: 11, 10: 11, 10.5: 11, 11.5: 12, 12.5: 13, 13.5: 14, 15: 16, 17: 18, 19: 20, 21: 20, 22: 24, 23: 24, 25: 24 };
/** 不是可见文字的字号：折叠侧栏用 font-size:0 藏标题（只认这一条精确写法）。 */
export const ALLOWED_EXCEPTIONS = ['.nav-collapsed .side-heading { font-size: 0;'];

const SIZE = /(font-size\s*:\s*)(\d+(?:\.\d+)?)px/g;
// font 简写：值里第一个 Npx 是字号（后面可能跟 /行高）
const SHORTHAND = /(\bfont\s*:\s*)([^;}]*)/g;

export function rewrite(css) {
  const counts = {};
  const bump = (from, to) => { const k = `${from}→${to}`; counts[k] = (counts[k] ?? 0) + 1; };
  let out = css.replace(SIZE, (m, head, n) => { const to = MAP[n]; if (to === undefined) return m; bump(n, to); return head + to + 'px'; });
  out = out.replace(SHORTHAND, (m, head, value) => head + value.replace(/(^|\s)(\d+(?:\.\d+)?)px/, (mm, sp, n) => { const to = MAP[n]; if (to === undefined) return mm; bump(n, to); return sp + to + 'px'; }));
  return { out, counts };
}

/** 列出文件里不在档位内的字号（含 font 简写）。 */
export function offenders(css) {
  const bad = [];
  for (const m of css.matchAll(/font-size\s*:\s*([^;}]*)/g)) {
    const v = m[1].trim().replace(/\s*!important$/, '');
    const px = /^(\d+(?:\.\d+)?)px$/.exec(v);
    if (px && (SCALE.includes(+px[1]) || KEEP.includes(+px[1]))) continue;
    const at = css.lastIndexOf('}', m.index) + 1, rule = css.slice(at, m.index + m[0].length + 1).trim();
    if (ALLOWED_EXCEPTIONS.some(e => rule.replace(/\s+/g, ' ').startsWith(e))) continue;
    bad.push(rule.slice(-160));
  }
  for (const m of css.matchAll(SHORTHAND)) {
    const px = /(?:^|\s)(\d+(?:\.\d+)?)px/.exec(m[2]);
    if (px && !SCALE.includes(+px[1]) && !KEEP.includes(+px[1])) bad.push(m[0].slice(0, 160));
  }
  return bad;
}

/** 把所有字号抹成占位符：改写前后应完全一致，证明只动了字号。 */
export function maskSizes(css) {
  return css.replace(SIZE, '$1#px').replace(SHORTHAND, (m, head, value) => head + value.replace(/(^|\s)(\d+(?:\.\d+)?)px/, '$1#px'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv[2] === '--check', files = process.argv.slice(check ? 3 : 2);
  let failed = false;
  for (const f of files) {
    const css = fs.readFileSync(f, 'utf8');
    if (check) { const bad = offenders(css); if (bad.length) { failed = true; console.log(`✗ ${f}: ${bad.length} 处不在档位\n  ` + bad.join('\n  ')); } else console.log(`✓ ${f}`); continue; }
    const { out, counts } = rewrite(css);
    if (maskSizes(out) !== maskSizes(css)) throw new Error(f + ': 改写触及字号以外的内容');
    fs.writeFileSync(f, out);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    console.log(`${f}: ${total} 处 ` + Object.entries(counts).sort((a, b) => parseFloat(a[0]) - parseFloat(b[0])).map(([k, v]) => `${k}px×${v}`).join('  '));
  }
  if (failed) process.exit(1);
}
