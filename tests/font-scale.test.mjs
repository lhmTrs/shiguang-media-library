// 字号统一防回退（UI 审计第二档）：已完成批次的 CSS 只能用 11/12/13/14/16/18/20/24（另保留 27、40 两个大字特例），
// 最小 11px。分四批推进，第四批起覆盖 src 下全部 CSS。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { rewrite, offenders, maskSizes } from './helpers/font-scale.mjs';

const root = path.resolve(import.meta.dirname, '..');
// 四批已全部完成：src 下所有 CSS 文件都必须在档位内（themes.css 由脚本生成、不含字号，也一并检查）。
const listCss = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? listCss(path.join(dir, e.name)) : e.name.endsWith('.css') ? [path.join(dir, e.name)] : []);
const DONE = listCss(path.join(root, 'src')).map(f => path.relative(root, f)).sort();

test('src 下全部 CSS 文件里没有档位以外的字号', () => {
  assert.ok(DONE.length >= 20 && DONE.includes('src/style.css'), '没有找到 CSS 文件：' + DONE.length);
  const report = DONE.map(f => [f, offenders(fs.readFileSync(path.join(root, f), 'utf8'))]).filter(([, bad]) => bad.length);
  assert.deepEqual(report, [], report.map(([f, bad]) => `${f}:\n  ${bad.join('\n  ')}`).join('\n'));
});

test('改写只动字号：font-size 与 font 简写里的字号，行高、粗细、字体族与其他属性不变', () => {
  const css = '.a{font-size:10px;padding:10px}.b{font-size: 10.5px !important}.c{font:600 15px/1.4 sans-serif;margin:15px}.d{font-size:13px}.e{font:12px/21px x}';
  const { out, counts } = rewrite(css);
  assert.equal(out, '.a{font-size:11px;padding:10px}.b{font-size: 11px !important}.c{font:600 16px/1.4 sans-serif;margin:15px}.d{font-size:13px}.e{font:12px/21px x}');
  assert.deepEqual(counts, { '10→11': 1, '10.5→11': 1, '15→16': 1 });
  assert.equal(maskSizes(out), maskSizes(css));
});

test('防回退只放行折叠侧栏隐藏标题这一条 font-size:0，其他 0 字号和非档位字号都报出', () => {
  assert.deepEqual(offenders('.x{font-size:11px}\n.nav-collapsed .side-heading { font-size: 0; justify-content: center; }'), []);
  assert.equal(offenders('.y{font-size:0}').length, 1);
  assert.equal(offenders('.z{font-size:10px}.w{font:600 9px/1 x}').length, 2);
  assert.equal(offenders('.v{font-size:1.2em}').length, 1);
});

// UI 审计第三档：!important 与层级（z-index）只许减少、不许增加。数字是 2026-11-16 main b5780e8 的现状（#114 新增层级值 4，种类 34→35）；
// 谁减少了，就把上限一起往下调（检查会提示）。只统计 src 下的 CSS 与 TS/TSX（行内 zIndex 也算）。
const MAX_IMPORTANT = 132;
const MAX_Z_VALUES = 35;
const walkSrc = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walkSrc(path.join(dir, e.name)) : [path.join(dir, e.name)]);
// CSS 里 !important 不分大小写，! 和 important 之间也允许空白，所以按 /!\s*important\b/i 计数。
export function cssDebt(files, read = f => fs.readFileSync(f, 'utf8')) {
  const perFile = {}; const zValues = new Set(); let important = 0;
  for (const f of files) {
    const text = read(f);
    if (f.endsWith('.css')) { const n = (text.match(/!\s*important\b/gi) || []).length; if (n) perFile[f] = n; important += n; }
    if (/\.(css|tsx?)$/.test(f)) for (const m of text.matchAll(/z-?index\s*:\s*['"]?(-?\d+)/gi)) zValues.add(Number(m[1]));
  }
  return { important, perFile, zValues: [...zValues].sort((a, b) => a - b) };
}

test('!important 总数和层级值种类不超过现状（只许减少）', () => {
  const files = walkSrc(path.join(root, 'src')).map(f => path.relative(root, f));
  const { important, perFile, zValues } = cssDebt(files, f => fs.readFileSync(path.join(root, f), 'utf8'));
  const top = Object.entries(perFile).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([f, n]) => `${f}: ${n}`).join('；');
  assert.ok(important <= MAX_IMPORTANT, `!important 从 ${MAX_IMPORTANT} 增加到 ${important}，请改用更具体的选择器。最多的文件：${top}`);
  assert.ok(zValues.length <= MAX_Z_VALUES, `层级值种类从 ${MAX_Z_VALUES} 增加到 ${zValues.length}，请复用已有的层级值：${zValues.join(',')}`);
  if (important < MAX_IMPORTANT || zValues.length < MAX_Z_VALUES) console.log(`可以把上限下调：MAX_IMPORTANT=${important}，MAX_Z_VALUES=${zValues.length}`);
});

test('防增统计：!important 只数 CSS，层级值按数值去重，行内 zIndex 也算', () => {
  const files = { 'a.css': '.a{color:red!important;z-index:5}.b{z-index: 5}.c{margin:0 !important}', 'b.tsx': "<div style={{zIndex: 7}}/>", 'c.ts': "const s='!important'" };
  const r = cssDebt(Object.keys(files), f => files[f]);
  assert.equal(r.important, 2); assert.deepEqual(r.zValues, [5, 7]); assert.deepEqual(r.perFile, { 'a.css': 2 });
});

test('防增统计：!IMPORTANT 等大小写写法和 ! important 也计数', () => {
  const files = { 'probe.css': '.p{margin:0 !IMPORTANT}.q{color:red !Important}.r{padding:0 ! important}' };
  assert.equal(cssDebt(['probe.css'], f => files[f]).important, 3);
});
