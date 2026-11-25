// 剧本区泳道图排版（src/script-area/map-layout.mjs）：合成样例，不起服务、不开浏览器。
import test from 'node:test';
import assert from 'node:assert/strict';
import { excerptKey, layoutMap, lineRange, shortDate, sourceCaption } from '../src/script-area/map-layout.mjs';
import { makeRenderData, readFixture } from './fixtures/script-area/make-render-data.mjs';

test('单版图：AI 补的框按行编号，手写 hv + offset 落在目标框的 offset 处，其余自动挑', () => {
  const l = layoutMap(readFixture('fixture_single'));
  assert.equal(l.mode, 'single');
  assert.equal(l.nodes.length, 8);
  assert.equal(l.all.n6.num, 1);
  assert.equal(l.nodes.filter(n => n.num != null).length, 1);
  const hv = l.edges.find(e => e.from === 'n6' && e.to === 'n4'), t = l.nodes.find(n => n.id === 'n4');
  assert.equal(hv.route, 'hv');
  assert.match(hv.d, new RegExp(` L${t.x + t.w * 0.5} ${t.y - 3}$`));
  assert.equal(l.edges.find(e => e.from === 'n1' && e.to === 'n4').route, 'v');
  assert.equal(l.edges.find(e => e.from === 'n2' && e.to === 'n6').route, 'd'); // 相邻泳道、下一行
  assert.equal(l.warnings.length, 0);
  // 泳道：主角宽 196，其余 120（不超过 5 条）
  assert.deepEqual(l.lanes.map(x => x.w), [120, 120, 196, 120]);
});

test('改动图：被删的框和它的箭头都不画，只留删除标记；行号压缩；改了因果的按行编号', () => {
  const g = readFixture('fixture_diff'), l = layoutMap(g);
  assert.equal(l.mode, 'diff');
  assert.ok(!l.nodes.some(n => n.id === 'e3'));
  assert.ok(!l.edges.some(e => e.from === 'e3' || e.to === 'e3'));
  assert.equal(l.delMarks.length, 1);
  assert.equal(l.delMarks[0].id, 'e3');
  assert.deepEqual(['e1', 'e2', 'e3', 'e6', 'e7'].map(id => l.all[id].num), [1, 2, 3, 4, 5]);
  assert.equal(l.all.e4.num, undefined); // 没变
  assert.equal(l.all.e8.num, undefined); // 只改措辞
  // 原来第 4 行（e3）空出来，后面的行往上挪一行
  assert.equal(l.nodes.find(n => n.id === 'e4').row, 4);
  const vh = l.edges.find(e => e.from === 'e5' && e.to === 'e6');
  assert.equal(vh.route, 'vh');
});

test('route 写 auto 和省略一样；不存在的端点不画', () => {
  const g = readFixture('fixture_single');
  const a = layoutMap(g), b = layoutMap({ ...g, edges: [...g.edges.map(e => e.route ? e : { ...e, route: 'auto' }), { from: 'n1', to: 'nope' }] });
  assert.deepEqual(b.edges, a.edges);
});

test('行号、来源名、日期的显示', () => {
  assert.equal(lineRange(13), 'L13');
  assert.equal(lineRange(7, 8), 'L7–L8');
  assert.equal(lineRange(7, 7), 'L7');
  assert.equal(shortDate(null), '');
  assert.equal(shortDate(new Date(2026, 10, 24, 2, 30).getTime(), true), '11-24 02:30');
  const at = new Date(2026, 10, 24, 9, 0).getTime();
  assert.equal(sourceCaption({ label: '文学稿', kind: 'material', at, sourceState: 'available' }), '文学稿（11-24 上传）');
  assert.equal(sourceCaption({ label: '文学稿', kind: 'material', at, sourceState: 'deleted' }), '文学稿（11-24 上传） · 原件已删除');
  assert.equal(sourceCaption({ label: '迁移时的稿子', kind: 'legacy', at, sourceState: 'available' }), '迁移时的稿子（11-24）');
});

test('假回包：quote 都去掉了，摘录按 source+start+end 能查到，空行照计', () => {
  const r = makeRenderData(readFixture('fixture_single'));
  assert.ok(!JSON.stringify(r.graph).includes('"quote"'));
  const ex = new Map(r.excerpts.map(e => [excerptKey(e.source, e.start, e.end), e]));
  assert.equal(ex.get(excerptKey('A', 3)).lines[0].text, '甲端起酒杯：今天是好日子。');
  assert.deepEqual(ex.get(excerptKey('A', 7, 8)).lines.map(x => x.number), [7, 8]);
});
