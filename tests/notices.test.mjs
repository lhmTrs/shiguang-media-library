// 待处理（后台任务结果通知）：真实服务 + 全新临时 SQLite，只用合成数据。设计见 NOTICES.md。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {tempDirectories} from './helpers/temp-cleanup.mjs';
import {startServer} from './helpers/project-music-server.mjs';
import {seedPendingRound} from './helpers/notices-fixture.mjs';

const makeTemp = tempDirectories(test, 'sg-notices-');
const uuid = () => crypto.randomUUID();
const card = (over = {}) => ({
  source: 'synthetic-runner', key: 'job-' + uuid().slice(0, 8), kind: 'decision', typeLabel: '生成失败 · 超时', title: '合成项目 · 第 1 集 · S2 镜',
  context: '合成：平台返回任务执行超时', costNote: '重做约花 1 次生成费', owner: {session: '合成会话', id: 'local_synthetic'},
  links: [{label: '看这镜', view: 'storyboard', projectId: uuid()}], occurredAt: Date.now() - 3 * 86_400_000, session: '合成跟进器', ...over,
});

test('待处理：放卡片、同编号只更新、只有页面能拍板、重做只记决定、执行结果、又失败开新卡、已读、稍后不计数', async t => {
  const base = await makeTemp(t);
  const s = await startServer(t, base);
  const N = '/notices';

  // AI 规则说明
  const schema = await s.call('GET', N + '/schema');
  assert.equal(schema.status, 200);
  assert.match(JSON.stringify(schema.body), /Sec-Fetch-Site: same-origin/);

  // 空
  let list = await s.call('GET', N);
  assert.equal(list.status, 200, list.text);
  assert.deepEqual(list.body.notices, []);
  assert.deepEqual(list.body.summary, {pending: 0, info: 0, later: 0, inflight: 0, ended: 0});

  // 放卡片：要带 x-local-token（全站写令牌）
  const noToken = await s.call('POST', N, card(), {headers: {'x-local-token': 'wrong'}});
  assert.equal(noToken.status, 403);
  // 字段校验
  assert.equal((await s.call('POST', N, card({kind: 'maybe'}))).body.code, 'INVALID_KIND');
  assert.equal((await s.call('POST', N, card({session: undefined}))).status, 400, '必须写放卡片的会话名');
  assert.equal((await s.call('POST', N, card({status: 'skipped'}))).body.code, 'FIELD_NOT_ALLOWED', 'AI 不能在放卡片时顺带设状态');
  assert.equal((await s.call('POST', N, card({links: [{label: '外链', view: 'http://example.com'}]}))).body.code, 'INVALID_LINK');
  assert.equal((await s.call('POST', N, card({source: 'project-music'}))).body.code, 'SOURCE_RESERVED');
  assert.equal((await s.call('POST', N, card({title: 'a\nb'}))).status, 400);

  const first = card();
  let r = await s.call('POST', N, first);
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.created, true);
  const A = r.body.notice;
  assert.equal(A.status, 'open');
  assert.equal(A.group, 'decision');
  assert.equal(A.awaitingUser, true);
  assert.equal(A.unassigned, false);
  assert.equal(A.occurredAt, first.occurredAt);

  // 同一个来源 + 原编号再放一次：只更新原卡，不出第二张；发生时间保留第一次的
  r = await s.call('POST', N, {...first, context: '合成：第二次报告，仍然超时', occurredAt: Date.now()});
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.created, r.body.updated], [false, true]);
  assert.equal(r.body.notice.id, A.id);
  assert.equal(r.body.notice.context, '合成：第二次报告，仍然超时');
  assert.equal(r.body.notice.occurredAt, first.occurredAt);
  r = await s.call('POST', N, {...first, context: '合成：第二次报告，仍然超时'});
  assert.deepEqual([r.body.created, r.body.updated], [false, false], '内容没变就不改');
  assert.equal((await s.call('POST', N, {...first, kind: 'info'})).body.code, 'KIND_MISMATCH');
  // 负责的会话不在了：标「待分派」
  r = await s.call('POST', N, {...first, owner: {session: '合成会话', id: 'local_synthetic', gone: true}});
  assert.equal(r.body.notice.unassigned, true);
  assert.equal((await s.call('GET', N + '?source=synthetic-runner')).body.notices.length, 1);

  // 顶栏 N：只算要你拍板、还没处理的
  let sum = (await s.call('GET', N + '/summary')).body.summary;
  assert.equal(sum.pending, 1);

  // 只有页面能拍板：没有 Sec-Fetch-Site: same-origin 一律拒绝（AI、后台程序）
  const rev = (await s.call('GET', `${N}/${A.id}`)).body.notice.revision;
  r = await s.call('PATCH', `${N}/${A.id}/decision`, {action: 'skip', expectedRevision: rev});
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'PAGE_ONLY');
  r = await s.call('PATCH', `${N}/${A.id}/decision`, {action: 'skip', expectedRevision: rev}, {headers: {'sec-fetch-site': 'same-site'}});
  assert.equal(r.status, 403, '同站不同源也不行');
  // 页面也要带写令牌
  r = await s.call('PATCH', `${N}/${A.id}/decision`, {action: 'skip', expectedRevision: rev}, {asPage: true, headers: {'x-local-token': 'wrong'}});
  assert.equal(r.status, 403);
  // 用户还没决定重做时，执行方不能回报结果
  r = await s.call('POST', `${N}/${A.id}/result`, {state: 'running', session: '合成跟进器'});
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'NOT_REDO_DECIDED');

  // 稍后：不计入 N，也不会自动回来
  r = await s.call('PATCH', `${N}/${A.id}/decision`, {action: 'later', expectedRevision: rev}, {asPage: true});
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.notice.status, 'later');
  assert.equal(r.body.notice.group, 'later');
  sum = (await s.call('GET', N + '/summary')).body.summary;
  assert.deepEqual([sum.pending, sum.later], [0, 1]);
  // 过期的版本号：409，并带回最新的卡
  r = await s.call('PATCH', `${N}/${A.id}/decision`, {action: 'skip', expectedRevision: rev}, {asPage: true});
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'REVISION_CONFLICT');
  assert.equal(r.body.details.notice.status, 'later');
  let cur = r.body.details.notice;
  // 只是告知的动作不适用于要拍板的卡；稍后的卡不能再点稍后
  assert.equal((await s.call('PATCH', `${N}/${A.id}/decision`, {action: 'read', expectedRevision: cur.revision}, {asPage: true})).body.code, 'ACTION_NOT_ALLOWED');
  assert.equal((await s.call('PATCH', `${N}/${A.id}/decision`, {action: 'later', expectedRevision: cur.revision}, {asPage: true})).body.code, 'ALREADY_DECIDED');
  // 重做要先看过花费（页面的确认框）
  assert.equal((await s.call('PATCH', `${N}/${A.id}/decision`, {action: 'redo', expectedRevision: cur.revision}, {asPage: true})).body.code, 'COST_NOT_ACKNOWLEDGED');

  // 重做：只记下决定，不执行任何东西（带上浏览器会自带的请求头，User-Agent 故意写长）
  const browserish = {'user-agent': 'Mozilla/5.0 SyntheticBrowser ' + 'x'.repeat(300), 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty'};
  r = await s.call('PATCH', `${N}/${A.id}/decision`, {action: 'redo', expectedRevision: cur.revision, costAcknowledged: true}, {asPage: true, headers: browserish});
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.notice.status, 'redo_decided');
  assert.equal(r.body.notice.statusLabel, '已决定重做');
  assert.equal(r.body.notice.awaitingUser, false);
  assert.equal(r.body.notice.decision.action, 'redo');
  assert.equal(r.body.notice.decision.by, 'user');
  // 每次决定都在历史里记下请求来历（只记录，不判断）：GET 读得到
  const decidedLog = (await s.call('GET', `${N}/${A.id}`)).body.notice.history.filter(h => h.event === 'decided');
  assert.deepEqual(decidedLog.map(h => h.note), ['later', 'redo']);
  const [laterOrigin, redoOrigin] = decidedLog.map(h => h.origin);
  // 只伪造了 Sec-Fetch-Site 的程序请求：Node 的 fetch 会自己带 Sec-Fetch-Mode: cors，但没有 Sec-Fetch-Dest，User-Agent 也不是浏览器
  assert.deepEqual([laterOrigin.fetchSite, laterOrigin.fetchDest], ['same-origin', null]);
  assert.ok(laterOrigin.userAgent && !/Mozilla/.test(laterOrigin.userAgent), laterOrigin.userAgent);
  assert.deepEqual([redoOrigin.fetchSite, redoOrigin.fetchMode, redoOrigin.fetchDest], ['same-origin', 'cors', 'empty']);
  assert.equal(redoOrigin.userAgent.length, 200, 'User-Agent 截到 200 字');
  assert.ok(redoOrigin.userAgent.startsWith('Mozilla/5.0 SyntheticBrowser '));
  // 被拒绝的请求（PAGE_ONLY）不改卡片，也就不留记录
  assert.ok(!(await s.call('GET', `${N}/${A.id}`)).body.notice.history.some(h => h.event === 'decided' && h.note === 'skip'));
  // 不能反悔成别的决定
  assert.equal((await s.call('PATCH', `${N}/${A.id}/decision`, {action: 'skip', expectedRevision: r.body.notice.revision}, {asPage: true})).body.code, 'ALREADY_DECIDED');
  // 执行方找到它
  list = await s.call('GET', N + '?source=synthetic-runner&status=redo_decided');
  assert.deepEqual(list.body.notices.map(n => n.id), [A.id]);
  sum = list.body.summary;
  assert.deepEqual([sum.pending, sum.later, sum.inflight], [0, 0, 1]);

  // 执行中 → 又失败：原卡结束，另开一张新卡
  r = await s.call('POST', `${N}/${A.id}/result`, {state: 'running', session: '合成跟进器'});
  assert.equal(r.body.notice.status, 'running');
  assert.equal((await s.call('POST', `${N}/${A.id}/result`, {state: 'running', session: '合成跟进器'})).body.repeated, true);
  assert.equal((await s.call('POST', `${N}/${A.id}/result`, {state: 'done', session: '合成跟进器', next: {typeLabel: 'x'}})).status, 400, 'next 只在失败时用');
  r = await s.call('POST', `${N}/${A.id}/result`, {state: 'failed', session: '合成跟进器', note: '合成：参考图尺寸不符'});
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.notice.status, 'failed');
  assert.equal(r.body.notice.group, 'ended');
  const B = r.body.next;
  assert.ok(B, '又失败要另开新卡');
  assert.notEqual(B.id, A.id);
  assert.equal(r.body.notice.nextId, B.id);
  assert.deepEqual([B.status, B.kind, B.attempt, B.previousId, B.key, B.typeLabel, B.context, B.costNote],
    ['open', 'decision', 2, A.id, first.key, '重做后又失败', '合成：参考图尺寸不符', first.costNote]);
  // 同一个结果再报一次：不重复开卡
  r = await s.call('POST', `${N}/${A.id}/result`, {state: 'failed', session: '合成跟进器'});
  assert.equal(r.body.repeated, true);
  assert.equal(r.body.next.id, B.id);
  assert.equal((await s.call('POST', `${N}/${A.id}/result`, {state: 'done', session: '合成跟进器'})).status, 409, '结束了的卡不能再改结果');
  // 同一个编号再放：更新的是新卡（最新一次），旧卡不动
  r = await s.call('POST', N, {...first, context: '合成：跟进器又报了一次'});
  assert.equal(r.body.notice.id, B.id);
  assert.equal((await s.call('GET', `${N}/${A.id}`)).body.notice.status, 'failed');

  // 新卡：重做 → 完成
  r = await s.call('PATCH', `${N}/${B.id}/decision`, {action: 'redo', expectedRevision: r.body.notice.revision, costAcknowledged: true}, {asPage: true});
  assert.equal(r.body.notice.status, 'redo_decided');
  r = await s.call('POST', `${N}/${B.id}/result`, {state: 'done', session: '合成跟进器', note: '合成：已入库'});
  assert.deepEqual([r.body.notice.status, r.body.next], ['done', null]);
  // 结束后同一个编号再放：不会重新挂起来
  r = await s.call('POST', N, first);
  assert.deepEqual([r.status, r.body.created, r.body.ended, r.body.notice.id], [200, false, true, B.id]);

  // 知道了，不重做
  const C = (await s.call('POST', N, card())).body.notice;
  r = await s.call('PATCH', `${N}/${C.id}/decision`, {action: 'skip', expectedRevision: C.revision}, {asPage: true});
  assert.deepEqual([r.body.notice.status, r.body.notice.group], ['skipped', 'ended']);

  // 只是告知：只能已读
  const D = (await s.call('POST', N, card({kind: 'info', typeLabel: '生成完成', costNote: undefined}))).body.notice;
  assert.equal(D.group, 'info');
  assert.equal((await s.call('PATCH', `${N}/${D.id}/decision`, {action: 'redo', expectedRevision: D.revision, costAcknowledged: true}, {asPage: true})).body.code, 'ACTION_NOT_ALLOWED');
  r = await s.call('PATCH', `${N}/${D.id}/decision`, {action: 'read', expectedRevision: D.revision}, {asPage: true});
  assert.deepEqual([r.body.notice.status, r.body.notice.group], ['read', 'ended']);

  // 已结束的历史保留；默认列表把没结束的放前面
  list = (await s.call('GET', N)).body;
  assert.equal(list.endedTotal, 4);
  assert.deepEqual(list.summary, {pending: 0, info: 0, later: 0, inflight: 0, ended: 4});
  assert.equal((await s.call('GET', N + '?endedLimit=1')).body.notices.length, 1);
  assert.equal((await s.call('GET', N + '?status=ended')).body.notices.length, 4);
  assert.equal((await s.call('GET', N + '?status=nope')).body.code, 'INVALID_STATUS');
  assert.equal((await s.call('GET', `${N}/${uuid()}`)).status, 404);
  assert.equal((await s.call('GET', `${N}/not-an-id`)).status, 404);
  // 历史里记着每一步，决定都是用户做的
  const hist = (await s.call('GET', `${N}/${A.id}`)).body.notice.history.map(h => [h.event, h.by]);
  assert.deepEqual(hist, [['posted', '合成跟进器'], ['updated', '合成跟进器'], ['updated', '合成跟进器'], ['decided', 'user'], ['decided', 'user'], ['running', '合成跟进器'], ['failed', '合成跟进器']]);
  // 不重做、已读也记来历，写在 decision.origin 里
  for (const id of [C.id, D.id]) assert.equal((await s.call('GET', `${N}/${id}`)).body.notice.decision.origin.fetchSite, 'same-origin');

  // 拍板之后来源用同一个编号再放 41 次：history 里 decided 那条被挤掉，decision.origin 还在
  const E = (await s.call('POST', N, card({key: 'job-crowd'}))).body.notice;
  r = await s.call('PATCH', `${N}/${E.id}/decision`, {action: 'redo', expectedRevision: E.revision, costAcknowledged: true}, {asPage: true, headers: browserish});
  assert.equal(r.status, 200, r.text);
  const decidedOrigin = r.body.notice.decision.origin;
  assert.deepEqual([decidedOrigin.fetchSite, decidedOrigin.fetchMode, decidedOrigin.fetchDest, decidedOrigin.userAgent.length], ['same-origin', 'cors', 'empty', 200]);
  for (let i = 1; i <= 41; i++) {
    r = await s.call('POST', N, card({key: 'job-crowd', context: `合成：第 ${i} 次检查，还在排队`}));
    assert.equal(r.body.updated, true, r.text);
  }
  const crowded = (await s.call('GET', `${N}/${E.id}`)).body.notice;
  assert.equal(crowded.status, 'redo_decided');
  assert.equal(crowded.history.length, 40);
  assert.ok(!crowded.history.some(h => h.event === 'decided'), 'decided 那条已经被挤出 history');
  assert.deepEqual(crowded.decision, {action: 'redo', at: crowded.decision.at, by: 'user', origin: decidedOrigin}, '来历还留在 decision 里');
  // 执行方回报之后也还在
  r = await s.call('POST', `${N}/${E.id}/result`, {state: 'running', session: '合成跟进器'});
  assert.deepEqual(r.body.notice.decision.origin, decidedOrigin);
});

test('待处理：项目音乐「待 AI 补写」自动成为只是告知的卡；补完自动结束；已读后不再挂起', async t => {
  const base = await makeTemp(t);
  const seed = await seedPendingRound(base);
  const other = await seedPendingRound(base, {projectName: '合成项目乙', songTitle: '合成歌曲乙'});
  const s = await startServer(t, base);
  let list = (await s.call('GET', '/notices')).body;
  assert.equal(list.notices.length, 2);
  const n = list.notices.find(x => x.key === seed.roundId), m = list.notices.find(x => x.key === other.roundId);
  assert.deepEqual([n.source, n.sourceLabel, n.key, n.kind, n.group, n.typeLabel, n.title],
    ['project-music', '项目音乐', seed.roundId, 'info', 'info', '待 AI 补写', '合成项目 · 合成歌曲 · 第 1 轮']);
  assert.match(n.context, /还缺问题整理、下一轮方向/);
  assert.deepEqual(n.links, [{label: '看这首歌', view: 'projectMusic', projectId: seed.projectId}]);
  assert.equal(list.summary.pending, 0, '只是告知的卡不计入顶栏的 N');
  assert.equal(list.summary.info, 2);
  // 再读一次不出第二张
  assert.equal((await s.call('GET', '/notices')).body.notices.length, 2);
  // 已读：结束；这一轮还在待补写清单里，但卡片不会重新挂起来
  let r = await s.call('PATCH', `/notices/${m.id}/decision`, {action: 'read', expectedRevision: m.revision}, {asPage: true});
  assert.equal(r.body.notice.status, 'read');
  await new Promise(r => setTimeout(r, 2100)); // 同步最多每 2 秒一次
  const again = (await s.call('GET', '/notices')).body;
  assert.equal(again.notices.find(x => x.key === other.roundId).status, 'read');
  assert.equal(again.notices.filter(x => x.key === other.roundId).length, 1);
  assert.equal(again.summary.info, 1);

  // AI 补写完 → 卡片自动结束
  const M = `/project-music/projects/${seed.projectId}`;
  const round = (await s.call('GET', M + `/songs/${seed.songId}`)).body.rounds[0];
  const w = await s.call('PATCH', M + `/rounds/${round.id}/agent-notes`, {expectedRevision: round.revision, session: '合成会话',
    issues: {items: [{text: '合成问题', source: 'objective_check', causeGuess: ''}]}, nextDirection: {text: '合成方向'}});
  assert.equal(w.status, 200, w.text);
  await new Promise(r => setTimeout(r, 2100)); // 同步最多每 2 秒一次
  const done = (await s.call('GET', `/notices/${n.id}`)).body.notice;
  assert.deepEqual([done.status, done.group, done.resolution.note], ['resolved', 'ended', '记录已经补完了']);
});
