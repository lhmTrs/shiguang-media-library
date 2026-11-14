// 字号统一防回退（UI 审计第二档）：已完成批次的 CSS 只能用 11/12/13/14/16/18/20/24（另保留 27、40 两个大字特例），
// 最小 11px。分批推进：DONE 列出已统一的文件，最后一批改为 src 下全部 CSS。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { rewrite, offenders, maskSizes } from './helpers/font-scale.mjs';

const root = path.resolve(import.meta.dirname, '..');
const DONE = [
  // 第一批
  'src/project-assets/asset-library.css',
  'src/project-videos/project-videos.css',
  'src/file-intake/file-intake.css',
  'src/library-workspace.css',
  'src/codex-task-drawer.css',
  // 第二批
  'src/storyboard/storyboard.css',
  'src/storyboard/video-preview.css',
  'src/storyboard/generation.css',
];

test('已统一的 CSS 文件里没有档位以外的字号', () => {
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
