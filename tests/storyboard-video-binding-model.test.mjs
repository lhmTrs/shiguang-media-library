// 分镜视频绑定 v2 前端纯逻辑，只用合成数据。
import test from 'node:test';
import assert from 'node:assert/strict';
import { canPlayStatus, coveredShotsText, defaultClip, estimateStart, newClipCount, safeMediaUrl, selectionChanges, selectionText, startText } from '../src/storyboard/shot-video-model.mjs';
import { boundText, episodeChoices, initialShotIds, nextText, orderedShotIds, sameBinding } from '../src/project-videos/shot-binding-model.mjs';

const shot = (shotId, durationMs, currentNumber = shotId) => ({ shotId, boundNumber: shotId, durationMs, currentNumber });
const clip = (id, boundAt, shots, extra = {}) => ({ id, name: id + '.mp4', durationMs: 12000, status: 'available', mediaUrl: '/api/m/' + id, boundRevision: 3, bindingRevision: 1, boundAt, origin: 'auto', needsReview: false, reviewFields: [], review: null, shots, ...extra });
const summary = (adopted = null, extra = {}) => ({ adopted, playVideoId: adopted?.videoId ?? null, candidateCount: 1, newCount: 0, needsReview: false, ...extra });
const use = (videoId, kind = 'video') => ({ videoId, videoName: videoId + '.mp4', kind });

test('估算起播：累加绑定版本里排在前面的镜头时长', () => {
  const c = clip('a', 1, [shot('01', 4000), shot('02', 3000), shot('03', 5000)]);
  assert.deepEqual(estimateStart(c, '01'), { startMs: 0, estimatedMs: 0, state: 'start' });
  assert.deepEqual(estimateStart(c, '03'), { startMs: 7000, estimatedMs: 7000, state: 'estimated' });
  assert.match(startText(estimateStart(c, '03')), /约从 0:07 起播.*不是准确切点/);
});

test('估算起播：用绑定版本时长，超过片长或镜头不在片内时从片头播', () => {
  const short = clip('a', 1, [shot('01', 9000), shot('02', 3000)], { durationMs: 8000 });
  assert.deepEqual(estimateStart(short, '02'), { startMs: 0, estimatedMs: 9000, state: 'beyond-end' });
  assert.match(startText(estimateStart(short, '02')), /超过片长/);
  assert.equal(estimateStart(short, '09').state, 'not-bound');
});

test('默认片子：后端指定优先，其次采用，最后最新绑定', () => {
  const clips = [clip('old', 1, []), clip('new', 9, []), clip('mid', 5, [])];
  assert.equal(defaultClip(clips, summary(use('old'), { playVideoId: 'mid' })).id, 'mid');
  assert.equal(defaultClip(clips, summary(use('old'))).id, 'old');
  assert.equal(defaultClip(clips, summary()).id, 'new');
  assert.equal(defaultClip([], summary()), null);
});

test('新片子数只在有采用时显示', () => {
  assert.equal(newClipCount(summary(use('a'), { newCount: 2 })), 2);
  assert.equal(newClipCount(summary(null, { newCount: 2 })), 0);
  assert.equal(newClipCount(undefined), 0);
});

test('整条采用：替换其它镜头的不同选择时要确认，前后两边写全', () => {
  const c = clip('b', 1, [shot('01', 1000), shot('02', 1000), shot('03', 1000, null)]);
  const result = selectionChanges('adopt-video', c, '01', { '01': summary(), '02': summary(use('a', 'shot')) });
  assert.equal(result.needsConfirm, true);
  assert.deepEqual(result.rows.map(r => r.shotId), ['01', '02'], '已不在当前稿的镜头不写入');
  assert.equal(result.rows[1].beforeText, 'a.mp4（单镜另选）');
  assert.equal(result.rows[1].afterText, 'b.mp4（整条采用）');
  assert.equal(result.rows[0].beforeText, selectionText(null));
});

test('不动其它镜头已有选择时不用确认', () => {
  const c = clip('b', 1, [shot('01', 1000), shot('02', 1000)]);
  assert.equal(selectionChanges('adopt-video', c, '01', { '01': summary(use('a')), '02': summary() }).needsConfirm, false, '当前镜是用户正在操作的');
  assert.equal(selectionChanges('adopt-video', c, '01', { '02': summary(use('b')) }).needsConfirm, false, '同一条片子不算替换');
  assert.equal(selectionChanges('adopt-shot', c, '01', { '01': summary(use('a')), '02': summary(use('a')) }).rows.length, 1);
});

test('取消整条只动正在用这条片子的镜头，并要确认', () => {
  const c = clip('b', 1, [shot('01', 1000), shot('02', 1000), shot('03', 1000)]);
  const result = selectionChanges('clear-video', c, '01', { '01': summary(use('b')), '02': summary(use('b')), '03': summary(use('a')) });
  assert.deepEqual(result.rows.map(r => r.shotId), ['01', '02']);
  assert.equal(result.rows[1].afterText, '未采用（播最新）');
  assert.equal(result.needsConfirm, true);
});

test('媒体状态和播放地址按真实情况判断', () => {
  assert.equal(canPlayStatus('available'), true); assert.equal(canPlayStatus('unchecked'), true);
  for (const status of ['missing', 'changed', 'untrusted', 'unsupported']) assert.equal(canPlayStatus(status), false);
  assert.equal(safeMediaUrl('/api/m/1', 'http://x.test'), 'http://x.test/api/m/1');
  assert.equal(safeMediaUrl('http://evil.test/api/m', 'http://x.test'), '');
  assert.equal(safeMediaUrl('/other/m', 'http://x.test'), '');
  assert.equal(coveredShotsText(clip('a', 1, [shot('01', 1, null)])), '当前稿没有这些镜头');
});

const projects = [
  { id: 'e2', name: '二', series_id: 's', season_id: 'a', episode_no: 2 }, { id: 'e1', name: '一', series_id: 's', season_id: 'a', episode_no: 1 },
  { id: 'x', name: '别的剧', series_id: 't', season_id: 'b', episode_no: 1 }, { id: 'solo', name: '未归组', series_id: null },
];
const rows = ['s1', 's2', 's3'].map((id, i) => ({ id, number: '0' + (i + 1), sceneIndex: 0, sceneName: '场', durationMs: 1000, summary: '' }));
const binding = { projectId: 'e1', projectName: '一', revision: 4, bindingRevision: 2, origin: 'auto', boundAt: 1, needsReview: false, reviewFields: [], shots: [{ shotId: 's1', boundNumber: '01', currentNumber: '01' }, { shotId: 'gone', boundNumber: '02', currentNumber: null }, { shotId: 's3', boundNumber: '03', currentNumber: '02' }] };

test('选集：本项目和同剧各集，未归组只有自己，已绑定的集也列出', () => {
  assert.deepEqual(episodeChoices(projects, 'e2').map(p => p.id), ['e1', 'e2']);
  assert.deepEqual(episodeChoices(projects, 'solo').map(p => p.id), ['solo']);
  assert.deepEqual(episodeChoices(projects, 'solo', 'x').map(p => p.id).sort(), ['solo', 'x']);
});

test('绑定弹窗：只预选当前还存在的镜头，保存按分镜顺序', () => {
  assert.deepEqual(initialShotIds(binding, 'e1', rows), ['s1', 's3']);
  assert.deepEqual(initialShotIds(binding, 'e2', rows), []);
  assert.deepEqual(orderedShotIds(rows, new Set(['s3', 's1'])), ['s1', 's3']);
});

test('绑定弹窗：前后文字写全，并能判断有没有改', () => {
  assert.equal(boundText(binding, projects), '第 1 集 · 一 · 第 4 版 · 镜 01、镜 02（已不在当前稿）、镜 03（现为镜 02）');
  assert.equal(nextText(projects[1], 5, rows, new Set(['s2'])), '第 1 集 · 一 · 第 5 版 · 镜 02');
  assert.equal(sameBinding(binding, 'e1', 4, ['s1', 'gone', 's3']), true);
  assert.equal(sameBinding(binding, 'e1', 5, ['s1', 'gone', 's3']), false);
  assert.equal(boundText(null, projects), '还没有对应镜头');
});
