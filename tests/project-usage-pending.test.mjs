// 素材使用页「待核对」保存规则（PROJECT-USAGE-RENDER v1，组合验收 C2 R2/R5）：纯函数单测。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';

const source = await fs.readFile(new URL('../src/project-usage/pending.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext}}).outputText;
const {applyPending, emptyPending, scopeOf} = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

const P = 'p1', A = 't-a', B = 't-b';
const intent = (requestId, timelineId = A, action = 'render-link') => ({requestId, projectId: P, timelineId: action === 'render-link' || action === 'render-unlink' ? timelineId : null, action});
const pend = (i, status = 'unknown') => ({intent: i, label: '正在关联成片…', status, message: ''});
const slot = (s, i) => s.slots[scopeOf(i)];

test('R5 同一时间线：旧请求 R 已有明确终态后，迟到的 unknown 不能覆盖新请求 N', () => {
  const R = intent('R'), N = intent('N');
  let s = applyPending(emptyPending(), R, pend(R));
  s = applyPending(s, R, null);                // R 核对得 failed：清除并记为已结束
  s = applyPending(s, N, pend(N));             // 同范围新意图 N 断连待核对
  s = applyPending(s, R, pend(R, 'unknown'));  // R 被扣住的旧 unknown 晚到
  assert.equal(slot(s, N).intent.requestId, 'N');
  s = applyPending(s, R, null);                // R 迟到的终态也不能清掉 N
  assert.equal(slot(s, N).intent.requestId, 'N');
});

test('R5 已结束的请求在空格里迟到，也不会被重新写回', () => {
  const R = intent('R');
  let s = applyPending(applyPending(emptyPending(), R, pend(R)), R, null);
  s = applyPending(s, R, pend(R, 'running'));
  assert.equal(slot(s, R), undefined);
});

test('同范围还有未决的 R 时，另一条 N 的结果不能覆盖 R；R 自己可以更新状态', () => {
  const R = intent('R'), N = intent('N');
  let s = applyPending(emptyPending(), R, pend(R));
  s = applyPending(s, N, pend(N));
  assert.equal(slot(s, R).intent.requestId, 'R');
  s = applyPending(s, R, pend(R, 'running'));
  assert.equal(slot(s, R).status, 'running');
});

test('R2 不同时间线、不同项目级操作各占一格，互不清除', () => {
  const a = intent('a', A), b = intent('b', B), ensure = intent('e', null, 'final-folder-ensure'), refresh = intent('r', null, 'video-info-refresh');
  let s = emptyPending();
  for (const i of [a, b, ensure, refresh]) s = applyPending(s, i, pend(i));
  assert.equal(Object.keys(s.slots).length, 4);
  s = applyPending(s, b, null);
  assert.deepEqual(Object.values(s.slots).map(p => p.intent.requestId).sort(), ['a', 'e', 'r']);
  assert.equal(scopeOf(intent('x', A, 'render-unlink')), scopeOf(a), '关联和解除同一条时间线共用一格');
});
