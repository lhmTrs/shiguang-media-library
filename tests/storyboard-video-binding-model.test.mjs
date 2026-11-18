// 分镜视频绑定 v2 前端纯逻辑，字段按合同 v1，只用合成数据。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { migrationText, migrationView, shotButtonLabel, canPlayStatus, clipFromItem, coveredShotsText, defaultClip, estimateStart, newClipCount, originText, reviewReasonText, rowsFromChanges, safeMediaUrl, selectionIntent, selectionText, startText, summariesFromState, v2ErrorText, wholeAdopted } from '../src/storyboard/shot-video-model.mjs';
import { adoptedShotsText, bindIntent, bindingFromResponse, bindingOriginText, boundText, initialShotIds, nextText, orderedShotIds, previewFromResponse, episodeLabel, releasedShotRefs, sameBinding, targetChoices, unbindConfirmation, unbindIntent } from '../src/project-videos/shot-binding-model.mjs';

const shot = (shotId, durationMs, currentNumber = shotId) => ({ shotId, numberAtBinding: shotId, durationMs, associationSeq: 1, existsInCurrent: currentNumber !== null, currentNumber });
const item = (id, shots, extra = {}, binding = {}, review = {}) => ({ videoId: id, sourceProjectId: 'src', name: id + '.mp4', durationMs: 12000, status: 'available', errorCode: null, mediaUrl: '/api/m/' + id, thumbnailUrl: null, videoRevision: 1,
  binding: { bindingId: 'b-' + id, revision: 2, targetProjectId: 'p', documentId: 'd', initializedAt: 1, storyboardRevision: 3, boundAt: 1, origin: 'agent', provenance: { storyboardRevision: 3 }, shots, ...binding },
  review: { needsReview: false, reasons: [], reviewedToRevision: null, reviewedAt: null, comparisonHash: 'h', canReview: true, disabledReason: null, ...review }, ...extra });
const clip = (...args) => clipFromItem(item(...args));
const use = (videoId, kind = 'whole') => ({ videoId, sourceProjectId: 'src', bindingId: 'b-' + videoId, kind, selectedAt: 1 });
const summary = (adopted = null, extra = {}) => ({ adopted, playVideoId: adopted?.videoId ?? null, candidateCount: 1, newCount: 0, needsReview: false, ...extra });

test('估算起播：累加绑定版本里排在前面的镜头时长', () => {
  const c = clip('a', [shot('01', 4000), shot('02', 3000), shot('03', 5000)]);
  assert.deepEqual(estimateStart(c, '01'), { startMs: 0, estimatedMs: 0, state: 'start' });
  assert.deepEqual(estimateStart(c, '03'), { startMs: 7000, estimatedMs: 7000, state: 'estimated' });
  assert.match(startText(estimateStart(c, '03')), /约从 0:07 起播.*不是准确切点/);
});

test('估算起播：超过实际片长时截到片尾附近，负时长不计，镜头不在片内从片头播', () => {
  const short = clip('a', [shot('01', 9000), shot('02', 3000)], { durationMs: 8000 });
  assert.deepEqual(estimateStart(short, '02'), { startMs: 7000, estimatedMs: 9000, state: 'beyond-end' });
  assert.deepEqual(estimateStart(short, '02', 20000), { startMs: 9000, estimatedMs: 9000, state: 'estimated' }, '实际片长优先');
  assert.match(startText(estimateStart(short, '02')), /超过片长/);
  assert.equal(estimateStart(short, '09').state, 'not-bound');
  assert.equal(estimateStart(clip('b', [shot('01', -500), shot('02', 1)]), '02').startMs, 0);
});

test('默认片子：后端指定优先，其次采用；采用读不到不换片；没有采用取列表第一条', () => {
  const clips = [clip('new', []), clip('mid', []), clip('old', [])];
  assert.equal(defaultClip(clips, summary(use('old'), { playVideoId: 'mid' })).id, 'mid');
  assert.equal(defaultClip(clips, summary(use('old'))).id, 'old');
  assert.equal(defaultClip(clips, summary(use('gone'))), null);
  assert.equal(defaultClip(clips, summary()).id, 'new');
  assert.equal(defaultClip([], summary()), null);
});

test('新片子数只在有采用时显示', () => {
  assert.equal(newClipCount(summary(use('a'), { newCount: 2 })), 2);
  assert.equal(newClipCount(summary(null, { newCount: 2 })), 0);
  assert.equal(newClipCount(undefined), 0);
});

test('读接口映射：每镜摘要和片子字段按合同', () => {
  const state = summariesFromState({ initialized: true, context: { selectionRevision: 4, storyboardRevision: 9 }, shots: [{ shotId: 's', number: '01', adopted: use('a'), defaultVideo: { videoId: 'a' }, candidateCount: 3, newVideoCount: 1, needsReview: true, reviewReasons: [] }] });
  assert.deepEqual([state.selectionRevision, state.storyboardRevision, state.shots.s.playVideoId, state.shots.s.newCount], [4, 9, 'a', 1]);
  assert.deepEqual(summariesFromState({ initialized: false, context: null, shots: [] }), { initialized: false, migration: null, selectionRevision: 0, storyboardRevision: 0, shots: {} });
  const c = clip('a', [shot('01', 1000), shot('02', 1000, null)], {}, {}, { reviewedToRevision: 8, reviewedAt: 5 });
  assert.deepEqual([c.bindingId, c.bindingRevision, c.boundRevision, c.provenanceRevision], ['b-a', 2, 3, 3]);
  assert.deepEqual(c.review, { revision: 8, at: 5 }); assert.equal(c.shots[1].currentNumber, null);
});

test('采用意图：每种操作只带需要的字段', () => {
  const c = clip('a', [shot('01', 1)]), context = { selectionRevision: 5, storyboardRevision: 9 }, base = { expectedSelectionRevision: 5, expectedStoryboardRevision: 9 }, video = { sourceProjectId: 'src', videoId: 'a', bindingId: 'b-a', expectedBindingRevision: 2 };
  assert.deepEqual(selectionIntent('adopt-video', c, '01', context), { action: 'adopt-video', ...base, ...video });
  assert.deepEqual(selectionIntent('adopt-shot', c, '01', context), { action: 'adopt-shot', ...base, ...video, shotId: '01' });
  assert.deepEqual(selectionIntent('clear-video', c, '01', context), { action: 'clear-video', ...base, ...video });
  assert.deepEqual(selectionIntent('clear-shot', c, '01', context), { action: 'clear-shot', ...base, shotId: '01' });
});

test('预览前后两边写全；整条是否都已采用按全部当前镜头判断', () => {
  const [row] = rowsFromChanges([{ projectId: 'p', shotId: 's', number: '01', before: { name: '旧.mp4', kind: 'shot' }, after: { name: '新.mp4', kind: 'whole' } }]);
  assert.deepEqual([row.beforeText, row.afterText], ['旧.mp4（单镜另选）', '新.mp4（整条采用）']);
  assert.equal(selectionText(null), '未采用（播最新）');
  const c = clip('b', [shot('01', 1), shot('02', 1), shot('03', 1, null)]);
  assert.equal(wholeAdopted(c, { '01': summary(use('b')), '02': summary(use('b')) }), true);
  assert.equal(wholeAdopted(c, { '01': summary(use('b')), '02': summary(use('b', 'shot')) }), false);
  assert.equal(wholeAdopted(clip('x', [shot('01', 1, null)]), {}), false);
});

test('来历和复核原因写法', () => {
  assert.equal(originText(clip('a', [])), '照第 3 版分镜 · 生成时记录');
  assert.equal(originText(clip('a', [], {}, { origin: 'manual', storyboardRevision: 6 })), '手动对应到第 6 版分镜 · 原生成出处第 3 版');
  assert.equal(originText(clip('a', [], {}, { origin: 'manual', storyboardRevision: 6, provenance: null })), '手动补录到第 6 版分镜 · 没有生成出处');
  assert.equal(reviewReasonText([{ category: 'sound_dialogue' }, { category: 'sound_dialogue' }, { category: 'audio_continuation' }, { category: 'new_kind' }]), '声音与对白、承接对白、new_kind');
});

test('错误说明：有后端说明用后端的，通用请求层丢了说明时按错误码', () => {
  assert.equal(v2ErrorText('STORYBOARD_CONFLICT', '具体说明'), '具体说明');
  assert.equal(v2ErrorText('STORYBOARD_CONFLICT', '请求失败'), '分镜刚被改过，这次没有写入。');
  assert.equal(v2ErrorText('UNKNOWN', '', '兜底'), '兜底');
});

test('媒体状态和播放地址按真实情况判断', () => {
  assert.equal(canPlayStatus('available'), true); assert.equal(canPlayStatus('unchecked'), true);
  for (const status of ['missing', 'changed', 'untrusted', 'unsupported']) assert.equal(canPlayStatus(status), false);
  assert.equal(safeMediaUrl('/api/m/1', 'http://x.test'), 'http://x.test/api/m/1');
  assert.equal(safeMediaUrl('http://evil.test/api/m', 'http://x.test'), '');
  assert.equal(safeMediaUrl('/other/m', 'http://x.test'), '');
  assert.equal(coveredShotsText(clip('a', [shot('01', 1, null)])), '当前稿没有这些镜头');
});

const projects = [
  { id: 'e2', name: '二', series_id: 's', season_id: 'a', episode_no: 2 }, { id: 'e1', name: '一', series_id: 's', season_id: 'a', episode_no: 1 },
  { id: 'x', name: '别的剧', series_id: 't', season_id: 'b', episode_no: 1 },
];
const targets = [{ projectId: 'e2', name: '二', seriesId: 's' }, { projectId: 'e1', name: '一', seriesId: 's' }];
const rows = ['s1', 's2', 's3'].map((id, i) => ({ id, number: '0' + (i + 1), sceneIndex: 0, sceneName: '场', durationMs: 1000, summary: '' }));
const response = (provenance = { storyboardRevision: 2 }, origin = 'agent') => ({ bindingRevision: 2, allowedTargets: targets, review: { needsReview: true }, binding: { bindingId: 'b', revision: 2, targetProjectId: 'e1', storyboardRevision: 4, boundAt: 1, origin, provenance, shots: [shot('s1', 1, '01'), { ...shot('gone', 1, null), numberAtBinding: '02' }, { ...shot('s3', 1, '02'), numberAtBinding: '03' }] } });
const binding = bindingFromResponse(response()).binding;

test('选集：以后端范围为准并按集排序；已绑定但不在范围的集不可选', () => {
  assert.deepEqual(targetChoices(targets, projects).map(p => [p.id, p.selectable]), [['e1', true], ['e2', true]]);
  assert.deepEqual(targetChoices(targets, projects, 'x').find(p => p.id === 'x').selectable, false);
  assert.equal(targetChoices([], [], 'gone', '').at(0).selectable, false);
});

test('集名已带第几集时不重复', () => {
  assert.equal(episodeLabel({ name: '合成剧 第1季 第1集', episode_no: 1 }), '合成剧 第1季 第1集');
  assert.equal(episodeLabel({ name: '开场', episode_no: 2 }), '第 2 集 · 开场');
  assert.equal(episodeLabel({ name: '未归组', episode_no: null }), '未归组');
});

test('绑定读取和来历写法', () => {
  assert.deepEqual([binding.projectId, binding.projectName, binding.revision, binding.bindingRevision, binding.needsReview], ['e1', '一', 4, 2, true]);
  assert.equal(bindingFromResponse({ bindingRevision: 0, allowedTargets: [], binding: null, review: null }).binding, null);
  assert.equal(bindingOriginText(binding), '生成时记录');
  assert.equal(bindingOriginText(bindingFromResponse(response(null, 'manual')).binding), '手动补录 · 没有生成出处');
  assert.equal(bindingOriginText(bindingFromResponse(response({ storyboardRevision: 2 }, 'manual')).binding), '手动修改 · 原生成出处第 2 版');
});

test('绑定意图和解除确认字段', () => {
  assert.deepEqual(bindIntent(2, 'e1', { revision: 7, assetStamp: 'x' }, ['s1']), { action: 'bind', expectedBindingRevision: 2, targetProjectId: 'e1', expectedStoryboardRevision: 7, expectedAssetStamp: 'x', shotIds: ['s1'] });
  assert.deepEqual(unbindIntent(2), { action: 'unbind', expectedBindingRevision: 2, targetProjectId: null, expectedStoryboardRevision: null, expectedAssetStamp: null, shotIds: [] });
  const plan = previewFromResponse({ previewHash: 'h', requiresConfirmation: true, affectedShots: [{ projectId: 'e1', projectName: '一', shotId: 'a', number: '01', before: { name: 'v', kind: 'whole' }, after: null }, { projectId: 'e1', projectName: '一', shotId: 'b', number: '02', before: null, after: null }] });
  assert.deepEqual(releasedShotRefs(plan.rows), [{ projectId: 'e1', shotId: 'a' }]);
});

test('旧操作的解除确认：带集用复合引用，旧后台沿用 ID，不同时发，ID 冲突不猜', () => {
  assert.deepEqual(unbindConfirmation([{ id: 's', number: 1, projectId: 'e1' }, { id: 's', number: 5, projectId: 'e2' }]), { confirmedUnbindShotRefs: [{ projectId: 'e1', shotId: 's' }, { projectId: 'e2', shotId: 's' }] });
  assert.deepEqual(unbindConfirmation([{ id: 's', number: 1 }]), { confirmedUnbindShotIds: ['s'] });
  assert.deepEqual(unbindConfirmation([]), { confirmedUnbindShotIds: [] });
  assert.throws(() => unbindConfirmation([{ id: 'a', shotId: 'b', number: 1 }]), /不一致/);
});

test('绑定弹窗：只预选当前还存在的镜头，保存按分镜顺序', () => {
  assert.deepEqual(initialShotIds(binding, 'e1', rows), ['s1', 's3']);
  assert.deepEqual(initialShotIds(binding, 'e2', rows), []);
  assert.deepEqual(orderedShotIds(rows, new Set(['s3', 's1'])), ['s1', 's3']);
});

test('绑定弹窗：前后文字写全，并能判断有没有改', () => {
  assert.equal(boundText(binding, projects), '第 1 集 · 一 · 第 4 版 · 镜 s1（现为镜 01）、镜 02（已不在当前稿）、镜 03（现为镜 02）');
  assert.equal(nextText(projects[1], 5, rows, new Set(['s2'])), '第 1 集 · 一 · 第 5 版 · 镜 02');
  assert.equal(sameBinding(binding, 'e1', 4, ['s1', 'gone', 's3']), true);
  assert.equal(sameBinding(binding, 'e1', 5, ['s1', 'gone', 's3']), false);
  assert.equal(boundText(null, projects), '还没有对应镜头');
});

test('受影响的采用：带集名时按集分开，旧后台不带集名时写法不变', () => {
  assert.equal(adoptedShotsText([{ id: 'a', number: 1 }, { id: 'b', number: 2 }]), '镜 1、镜 2');
  assert.equal(adoptedShotsText([{ id: 'a', number: 1, projectId: 'e1', projectName: '一' }, { id: 'a', number: 5, projectId: 'e2', projectName: '二' }, { id: 'b', number: 2, projectId: 'e1', projectName: '一' }]), '一：镜 1、镜 2；二：镜 5');
  assert.equal(adoptedShotsText([]), '');
});

const fixture = name => JSON.parse(fs.readFileSync(new URL('./fixtures/storyboard-video-v2/' + name + '.json', import.meta.url), 'utf8'));

test('后端合成样例：状态、候选、绑定、预览、错误和复合确认都能按合同读取', () => {
  const state = summariesFromState(fixture('state')), shot01 = Object.values(state.shots)[0];
  assert.equal(shot01.number, '01'); assert.equal(shot01.adopted.name, '合成视频'); assert.equal(shot01.playVideoId, shot01.adopted.videoId);
  const candidate = clipFromItem(fixture('candidates').items[0]);
  assert.equal(coveredShotsText(candidate), '镜 01、镜 02'); assert.equal(estimateStart(candidate, candidate.shots[1].shotId).state, 'estimated');
  const read = bindingFromResponse(fixture('binding')); assert.equal(read.binding.projectName, '合成集'); assert.equal(read.targets.length > 0, true);
  const preview = previewFromResponse(fixture('binding-preview'));
  assert.deepEqual([preview.rows[0].beforeText, preview.rows[0].afterText], ['合成视频（整条采用）', '未采用（播最新）']);
  assert.deepEqual(releasedShotRefs(preview.rows), [{ projectId: preview.rows[0].projectId, shotId: 'shot_1' }]);
  const error = fixture('error'); assert.equal(v2ErrorText(error.code, error.message), error.error);
  const { confirmedUnbindShotRefs: refs } = fixture('unbind-confirmation');
  assert.deepEqual(unbindConfirmation(refs.map(ref => ({ id: ref.shotId, projectId: ref.projectId, number: '1' }))), { confirmedUnbindShotRefs: refs });
});

test('迁移状态：完成时不打扰；暂缓时写清状态、保护未知和裁剪暂停', () => {
  assert.equal(migrationView({ status: 'complete', writeAllowed: true, adoptionKnown: true, historyPrune: 'active' }), null);
  assert.equal(migrationView(undefined), null);
  const state = summariesFromState(fixture('state-deferred')), view = state.migration, [id] = Object.keys(state.shots);
  assert.equal(view.blocked, true); assert.equal(view.adoptionKnown, false); assert.equal(view.prunePaused, true); assert.equal(view.shortLabel, '已暂缓');
  assert.match(migrationText(view), /已暂缓.*暂时无法确认.*旧版本清理已暂停/); assert.equal(state.shots[id].candidateCount, null);
  assert.equal(shotButtonLabel(state, id), '已暂缓'); assert.equal(newClipCount(state.shots[id]), 0);
  assert.equal(migrationView({ status: 'pending', writeAllowed: true, adoptionKnown: true, historyPrune: 'paused' }).blocked, false);
});

test('镜号按钮：数量未知不写无片子，确实为 0 才写', () => {
  const data = c => ({ migration: null, shots: { s: { candidateCount: c } } });
  assert.equal(shotButtonLabel(null, 's'), '播放'); assert.equal(shotButtonLabel(data(2), 's'), '播放'); assert.equal(shotButtonLabel(data(null), 's'), '播放'); assert.equal(shotButtonLabel(data(0), 's'), '无片子');
});
