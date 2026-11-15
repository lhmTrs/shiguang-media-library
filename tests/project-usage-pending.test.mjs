// 素材使用页「待核对」保存规则（PROJECT-USAGE-RENDER v1，组合验收 C2 R2/R5）：纯函数单测。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';

const source = await fs.readFile(new URL('../src/project-usage/pending.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext}}).outputText;
const {applyPending, beginPending, emptyPending, scopeOf} = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

const P = 'p1', A = 't-a', B = 't-b';
const intent = (requestId, timelineId = A, action = 'render-link') => ({requestId, projectId: P, timelineId: action === 'render-link' || action === 'render-unlink' ? timelineId : null, action});
const pend = (i, status = 'unknown') => ({intent: i, label: '正在关联成片…', status, message: ''});
const slot = (s, i) => s.slots[scopeOf(i)];

// 真实使用顺序：发请求前登记（begin），之后的回执经 applyPending
const begin = (s, i) => beginPending(s, i);
const put = (s, i, p) => applyPending(s, i, p);

test('R5 同一时间线：旧请求 R 已有明确结果后，迟到的 unknown / 终态都不能覆盖或清掉新请求 N', () => {
  const R = intent('R'), N = intent('N');
  let s = put(begin(emptyPending(), R), R, pend(R));
  s = put(s, R, null);                         // R 核对得 failed：注销
  s = put(begin(s, N), N, pend(N));            // 同范围新意图 N 断连待核对
  s = put(s, R, pend(R, 'unknown'));           // R 被扣住的旧 unknown 晚到
  assert.equal(slot(s, N).intent.requestId, 'N');
  s = put(s, R, null);                         // R 迟到的终态也不能清掉 N
  assert.equal(slot(s, N).intent.requestId, 'N');
});

test('R5 边界：R 结束后又有 250 条请求各自结束，格空着时 R 的迟到回执仍不复活（不靠历史条数）', () => {
  const R = intent('R');
  let s = put(put(begin(emptyPending(), R), R, pend(R)), R, null);
  for (let n = 0; n < 250; n++) { const x = intent('x' + n); s = put(put(begin(s, x), x, pend(x)), x, null); }
  assert.equal(Object.keys(s.slots).length, 0);
  s = put(s, R, pend(R, 'unknown'));
  assert.equal(slot(s, R), undefined);
  assert.deepEqual(s.live, [], '登记表只装还没结果的请求');
});

test('从没登记过的请求（外来或已注销）的回执一律忽略', () => {
  const X = intent('X');
  assert.equal(slot(put(emptyPending(), X, pend(X)), X), undefined);
});

test('同范围还有未决的 R 时，另一条 N 的结果不能覆盖 R；R 自己可以更新状态', () => {
  const R = intent('R'), N = intent('N');
  let s = put(begin(emptyPending(), R), R, pend(R));
  s = put(begin(s, N), N, pend(N));
  assert.equal(slot(s, R).intent.requestId, 'R');
  s = put(s, R, pend(R, 'running'));
  assert.equal(slot(s, R).status, 'running');
});

test('R2 不同时间线、不同项目级操作各占一格，互不清除', () => {
  const a = intent('a', A), b = intent('b', B), ensure = intent('e', null, 'final-folder-ensure'), refresh = intent('r', null, 'video-info-refresh');
  let s = emptyPending();
  for (const i of [a, b, ensure, refresh]) s = put(begin(s, i), i, pend(i));
  assert.equal(Object.keys(s.slots).length, 4);
  s = put(s, b, null);
  assert.deepEqual(Object.values(s.slots).map(p => p.intent.requestId).sort(), ['a', 'e', 'r']);
  assert.equal(scopeOf(intent('x', A, 'render-unlink')), scopeOf(a), '关联和解除同一条时间线共用一格');
});
