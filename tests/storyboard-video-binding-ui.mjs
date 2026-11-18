// 分镜视频绑定 v2 前端界面测试：真实组件 + 合成数据 + 无头浏览器。
// 走真实接口层，后端是页面内按合同 v1 回应的合成实现；不启动拾光服务、不连真实库。和后端分支的组合测试另算。
// 用法：node tests/storyboard-video-binding-ui.mjs（CREATIVE_TEST_EVIDENCE=目录 时保存截图）
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'video-binding-ui-')));
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const makeVideo = (name, color, seconds) => { const file = path.join(temp, name); const run = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=96x64:r=8:d=${seconds}`, '-c:v', 'libvpx', '-b:v', '60k', '-g', '4', '-an', '-y', file]); assert.equal(run.status, 0, String(run.stderr)); };
let server, browser, page, passed = false; const errors = [];
const check = async (name, fn) => { await fn(); console.log('PASS ' + name); };
const shotImage = async name => { const dir = process.env.CREATIVE_TEST_EVIDENCE; if (dir) { await fs.mkdir(dir, { recursive: true }); await page.screenshot({ path: path.join(dir, name + '.png') }); } };

const bound = (shotId, durationMs, currentNumber = shotId) => ({ shotId, numberAtBinding: shotId, durationMs, associationSeq: 1, existsInCurrent: currentNumber !== null, currentNumber });
const provenance = { provenanceId: 'pr', instanceId: 'i', projectId: 'p1', documentId: 'd', initializedAt: 1, storyboardRevision: 3, shotIds: [], createdAt: 1, inputHash: 'x' };
// videos 数组的顺序就是后端返回的顺序：最新绑定在前。
const clip = (id, shots, { file = 'long', binding = {}, review = {}, ...extra } = {}) => ({ videoId: id, sourceProjectId: 'e1', name: id + '.webm', durationMs: 12000, status: 'available', errorCode: null, mediaUrl: '/api/media/' + file + '.webm', thumbnailUrl: null, videoRevision: 1,
  binding: { bindingId: 'b-' + id, revision: 1, targetProjectId: 'p1', documentId: 'd', initializedAt: 1, storyboardRevision: 3, boundAt: 1700000000000, origin: 'agent', provenance, shots, ...binding },
  review: { needsReview: false, reasons: [], reviewedToRevision: null, reviewedAt: null, comparisonHash: 'hash-' + id, canReview: true, disabledReason: null, ...review }, ...extra });
const use = (videoId, kind = 'whole') => ({ videoId, sourceProjectId: 'e1', bindingId: 'b-' + videoId, kind, selectedAt: 1 });
const shot = (shotId, adopted = null, extra = {}) => ({ shotId, number: shotId, adopted, candidateCount: 2, newVideoCount: 0, needsReview: false, reviewReasons: [], ...extra });
const three = () => [bound('01', 4000), bound('02', 3000), bound('03', 5000)];
const scenario = (shots, videos) => ({ context: { instanceId: 'i', projectId: 'p1', documentId: 'd', initializedAt: 1, storyboardRevision: 9, assetStamp: 'a', selectionRevision: 5 }, shots, videos });
const openShot = async (data, shotId = '03') => { await page.goto(origin + '/'); await page.evaluate(([f, id]) => window.mountShot(f, id, id), [data, shotId]); const d = page.getByRole('dialog', { name: '镜 ' + shotId + ' 的片子' }); await expect(d).toBeVisible(); await expect(d.getByRole('heading', { name: /这一镜的片子 · / })).toBeVisible(); return d; };
const fake = expr => page.evaluate(expr);
const sent = route => fake(`fake.requests.filter(r => r.method !== 'GET' && r.path.endsWith(${JSON.stringify(route)}))`);
const player = d => d.locator('video');
const card = (d, name) => d.getByRole('article', { name });
const insideBox = async (outer, inner) => { const a = await outer.boundingBox(), b = await inner.boundingBox(); assert.ok(b.x >= a.x && b.x + b.width <= a.x + a.width + 1, '内容不能被裁掉'); };
let origin;

try {
  makeVideo('long.webm', 'navy', 12); makeVideo('other.webm', 'maroon', 12);
  const bundle = await build({ entryPoints: [path.join(root, 'tests/fixtures/video-binding-harness.tsx')], bundle: true, write: false, outdir: '/', format: 'iife', jsx: 'automatic', loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' }, define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' });
  const asset = ext => bundle.outputFiles.find(file => file.path.endsWith(ext)).contents;
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end('<!doctype html><link rel=stylesheet href=/h.css><div id=root></div><script src=/h.js></script>'); }
    if (url.pathname === '/h.js') { res.setHeader('content-type', 'text/javascript'); return res.end(asset('.js')); }
    if (url.pathname === '/h.css') { res.setHeader('content-type', 'text/css'); return res.end(asset('.css')); }
    const media = url.pathname.match(/^\/api\/media\/(long|other)\.webm$/);
    if (!media) { res.statusCode = 404; return res.end(); }
    const file = path.join(temp, media[1] + '.webm'), size = (await fs.stat(file)).size, range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    res.setHeader('content-type', 'video/webm'); res.setHeader('accept-ranges', 'bytes');
    if (!range) { res.setHeader('content-length', size); return createReadStream(file).pipe(res); }
    const start = Number(range[1]), end = range[2] ? Number(range[2]) : size - 1;
    res.statusCode = 206; res.setHeader('content-range', `bytes ${start}-${end}/${size}`); res.setHeader('content-length', end - start + 1); createReadStream(file, { start, end }).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] }); page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', e => errors.push(e.message));

  await check('规则播放：有采用播采用，按绑定版本前面镜头时长估算起播，文字不暗示精确', async () => {
    const d = await openShot(scenario([shot('03', use('old'))], [clip('new', three(), { file: 'other' }), clip('old', three())]));
    await expect(player(d)).toHaveAttribute('aria-label', '正在播放 old.webm');
    await expect.poll(() => player(d).evaluate(v => v.currentTime), { timeout: 10000 }).toBeGreaterThan(6.5);
    assert.ok(await player(d).evaluate(v => v.currentTime) < 10, '应从估算位置附近开始');
    await expect(d.getByTestId('sv-start')).toHaveText('约从 0:07 起播，按分镜时长估算，不是准确切点'); await shotImage('shot-player');
  });

  await check('规则播放：没有采用播最新，不显示新片子数', async () => {
    const d = await openShot(scenario([shot('03', null, { newVideoCount: 3 })], [clip('new', three(), { file: 'other' }), clip('old', three())]));
    await expect(player(d)).toHaveAttribute('aria-label', '正在播放 new.webm'); await expect(d.getByText(/条新片子/)).toHaveCount(0);
  });

  await check('采用的片子读不到时不悄悄换片', async () => {
    const d = await openShot(scenario([shot('03', use('gone'))], [clip('new', three())]));
    await expect(d.getByRole('alert')).toContainText('采用的片子暂时读不到'); await expect(player(d)).toHaveCount(0);
  });

  await check('新片子到来：只被动显示 N 条，不弹框，不改变播放和采用', async () => {
    const d = await openShot(scenario([shot('03', use('old'))], [clip('old', three())])); const src = await player(d).getAttribute('src');
    await fake(`fake.shots[0].newVideoCount = 2; window.dispatchEvent(new Event('focus'))`);
    await expect(d.getByText('有 2 条新片子')).toBeVisible(); await expect(page.getByRole('alertdialog')).toHaveCount(0);
    assert.equal(await player(d).getAttribute('src'), src); assert.equal((await sent('/selections')).length, 0);
  });

  await check('整条采用：按后端预览列前后对比，取消不写，确认才带预览号写入', async () => {
    const d = await openShot(scenario([shot('01', use('old', 'shot')), shot('02'), shot('03', use('old'))], [clip('new', three(), { file: 'other' }), clip('old', three())]));
    await card(d, 'new.webm').getByRole('button', { name: /^采用/ }).click();
    const confirm = page.getByRole('alertdialog', { name: '采用这条片子' }); await expect(confirm).toBeVisible();
    const row = confirm.getByRole('row').filter({ hasText: '镜 01' }); await expect(row).toContainText('old.webm（单镜另选）'); await expect(row).toContainText('new.webm（整条采用）'); await expect(confirm.getByRole('columnheader', { name: '确认后' })).toBeVisible(); await insideBox(confirm, row.getByRole('cell').nth(2)); await shotImage('adopt-confirm');
    await confirm.getByRole('button', { name: '取消' }).click(); assert.equal((await sent('/selections')).length, 0);
    await card(d, 'new.webm').getByRole('button', { name: /^采用/ }).click(); await page.getByRole('alertdialog').getByRole('button', { name: '确认修改' }).click();
    await expect(d.getByText('已更新采用。正在播放的片子没有变。')).toBeVisible();
    const [w] = await sent('/selections'), b = w.body;
    assert.deepEqual([b.action, b.sourceProjectId, b.videoId, b.bindingId, b.expectedBindingRevision, b.expectedSelectionRevision, b.expectedStoryboardRevision, b.confirmReplace], ['adopt-video', 'e1', 'new', 'b-new', 1, 5, 9, true]);
    assert.equal('shotId' in b, false, '整条采用不带单镜'); assert.match(b.previewHash, /^preview-5-/); assert.match(b.requestId, /^[0-9a-f-]{36}$/); assert.equal(w.headers['X-Local-Token'], 'test-token');
    await expect(player(d)).toHaveAttribute('aria-label', '正在播放 old.webm'); await expect(card(d, 'new.webm').getByText('已采用')).toBeVisible();
  });

  await check('单镜另选只动这一镜；没有替换时不用确认，取消已有采用要确认', async () => {
    const d = await openShot(scenario([shot('01', use('old')), shot('02', use('old')), shot('03')], [clip('new', three(), { file: 'other' }), clip('old', three())]));
    await card(d, 'new.webm').getByRole('button', { name: '只这一镜用' }).click(); await expect(card(d, 'new.webm').getByText('这一镜单独选用')).toBeVisible();
    assert.equal(await fake(`fake.shots[0].adopted.videoId`), 'old'); assert.equal((await sent('/selections'))[0].body.shotId, '03'); assert.equal('confirmReplace' in (await sent('/selections'))[0].body, false);
    await card(d, 'new.webm').getByRole('button', { name: '取消这一镜的采用' }).click();
    const confirm = page.getByRole('alertdialog', { name: '取消这一镜的采用' }); await expect(confirm).toContainText('未采用（播最新）'); await confirm.getByRole('button', { name: '确认修改' }).click();
    await expect(card(d, 'new.webm').getByText('这一镜单独选用')).toHaveCount(0);
    const clear = (await sent('/selections'))[1].body; assert.equal(clear.action, 'clear-shot'); assert.equal('videoId' in clear, false, '取消单镜只带镜头');
  });

  await check('多窗口冲突：不覆盖，重读最新结果并提示，播放不变，重试用最新修订号', async () => {
    const d = await openShot(scenario([shot('03')], [clip('new', three(), { file: 'other' }), clip('old', three())]));
    await expect(player(d)).toHaveAttribute('aria-label', '正在播放 new.webm'); const reads = await fake('fake.clipReads');
    await fake(`fake.fail = { code: 'VIDEO_SELECTION_CONFLICT', mutate: "fake.context.selectionRevision = 8; fake.shots[0].adopted = { videoId: 'old', sourceProjectId: 'e1', bindingId: 'b-old', kind: 'whole', selectedAt: 1 }" }`);
    await card(d, 'new.webm').getByRole('button', { name: '只这一镜用' }).click();
    await expect(d.getByRole('alert')).toContainText('其他窗口刚改过'); await expect(card(d, 'old.webm').getByText('已采用')).toBeVisible();
    assert.ok(await fake('fake.clipReads') > reads); await expect(player(d)).toHaveAttribute('aria-label', '正在播放 new.webm');
    await card(d, 'new.webm').getByRole('button', { name: '只这一镜用' }).click(); await page.getByRole('alertdialog').getByRole('button', { name: '确认修改' }).click(); await expect(card(d, 'new.webm').getByText('这一镜单独选用')).toBeVisible();
    assert.equal((await sent('/selections')).at(-1).body.expectedSelectionRevision, 8);
  });

  await check('写入结果未知：再点原样重发同一请求，不重新预览，也不重复生效', async () => {
    const d = await openShot(scenario([shot('03')], [clip('new', three())]));
    await fake(`fake.dropResponse = true`); await card(d, 'new.webm').getByRole('button', { name: '只这一镜用' }).click(); await expect(d.getByRole('alert')).toContainText('网络中断');
    await card(d, 'new.webm').getByRole('button', { name: '只这一镜用' }).click(); await expect(card(d, 'new.webm').getByText('这一镜单独选用')).toBeVisible();
    const writes = await sent('/selections'); assert.equal(writes.length, 2); assert.equal(writes[0].body.requestId, writes[1].body.requestId); assert.equal(writes[0].body.previewHash, writes[1].body.previewHash);
    assert.equal((await sent('/selections/preview')).length, 1); assert.equal(await fake('fake.context.selectionRevision'), 6);
  });

  await check('需复核：片子照常播；点已复核带比较基准，标记消失、显示版本，可撤销', async () => {
    const d = await openShot(scenario([shot('03', use('old'), { needsReview: true })], [clip('old', three(), { review: { needsReview: true, reasons: [{ category: 'action', shotIds: ['03'] }, { category: 'duration', shotIds: ['03'] }, { category: 'action', shotIds: ['01'] }] } }), clip('ok', three())]));
    const c = card(d, 'old.webm'); await expect(player(d)).toHaveAttribute('aria-label', '正在播放 old.webm'); await expect(c.getByText('需复核')).toBeVisible(); await expect(c).toContainText('有变化：画面与人物动作、时长');
    await expect(card(d, 'ok.webm').getByRole('button', { name: '已复核' })).toHaveCount(0); await shotImage('needs-review');
    await c.getByRole('button', { name: '已复核' }).click(); await expect(c.getByText('需复核')).toHaveCount(0); await expect(c).toContainText('已复核到第 9 版');
    const [w] = await sent('/ui/source-projects/e1/videos/old/review'); assert.deepEqual([w.body.action, w.body.expectedBindingRevision, w.body.seenStoryboardRevision, w.body.expectedComparisonHash], ['confirm', 1, 9, 'hash-old']);
    await c.getByRole('button', { name: '撤销复核' }).click(); await expect(c.getByText('需复核')).toBeVisible();
    const undo = (await sent('/ui/source-projects/e1/videos/old/review'))[1].body; assert.deepEqual([undo.action, undo.expectedBindingRevision], ['undo', 2]);
  });

  await check('不能核验时不让复核并说明原因；复核冲突时重读', async () => {
    let d = await openShot(scenario([shot('03')], [clip('a', three(), { review: { needsReview: true, reasons: [{ category: 'dependency_unverifiable', shotIds: [] }], canReview: false, disabledReason: '参考图无法核对' } })]));
    let c = card(d, 'a.webm'); await expect(c.getByRole('button', { name: '已复核' })).toBeDisabled(); await expect(c).toContainText('暂时不能复核：参考图无法核对'); await expect(c).toContainText('有依赖无法核对');
    d = await openShot(scenario([shot('03')], [clip('a', three(), { review: { needsReview: true } })])); c = card(d, 'a.webm');
    await fake(`fake.videos[0].review.comparisonHash = 'moved'`); await c.getByRole('button', { name: '已复核' }).click(); await expect(d.getByRole('alert')).toContainText('其他窗口刚改过，或内容刚有变化');
    await c.getByRole('button', { name: '已复核' }).click(); await expect(c.getByText('需复核')).toHaveCount(0);
  });

  await check('来历：手动补录不写成照某版生成，手动改绑保留原生成出处', async () => {
    const d = await openShot(scenario([shot('03')], [clip('hand', three(), { binding: { origin: 'manual', provenance: null, storyboardRevision: 6 } }), clip('moved', three(), { binding: { origin: 'manual', storyboardRevision: 6 } }), clip('auto', three())]));
    await expect(card(d, 'hand.webm')).toContainText('手动补录到第 6 版分镜 · 没有生成出处'); await expect(card(d, 'hand.webm')).not.toContainText('照第');
    await expect(card(d, 'moved.webm')).toContainText('手动对应到第 6 版分镜 · 原生成出处第 3 版'); await expect(card(d, 'auto.webm')).toContainText('照第 3 版分镜 · 生成时记录');
  });

  await check('媒体失效按真实状态提示；实际片长优先于登记时长，估算超片长时跳到片尾附近', async () => {
    let d = await openShot(scenario([shot('03', use('gone'))], [clip('gone', three(), { status: 'missing' })]));
    await expect(d.getByRole('alert')).toContainText('原视频文件缺失'); await expect(player(d)).toHaveCount(0);
    d = await openShot(scenario([shot('03')], [clip('stale', three(), { durationMs: 5000 })])); await expect.poll(() => player(d).evaluate(v => v.currentTime), { timeout: 10000 }).toBeGreaterThan(6.5); await expect(d.getByTestId('sv-start')).toContainText('约从 0:07');
    d = await openShot(scenario([shot('03')], [clip('long', [bound('01', 9000), bound('02', 5000), bound('03', 1000)])])); await expect(d.getByTestId('sv-start')).toContainText('超过片长，已跳到片尾附近'); await expect.poll(() => player(d).evaluate(v => v.currentTime), { timeout: 10000 }).toBeGreaterThan(10.5);
    d = await openShot({ ...scenario([shot('03', null, { candidateCount: 0 })], []) }); await expect(d.getByText('这一镜还没有对应的片子')).toBeVisible(); await expect(d.getByText('到生成视频页右键片子，选「对应到分镜镜头…」。')).toBeVisible();
  });

  await check('Esc：先关确认层，再关窗口', async () => {
    const d = await openShot(scenario([shot('01', use('old')), shot('02'), shot('03')], [clip('new', three()), clip('old', [bound('01', 1000)])]));
    await card(d, 'new.webm').getByRole('button', { name: /^采用/ }).click(); await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.keyboard.press('Escape'); await expect(page.getByRole('alertdialog')).toHaveCount(0); await expect(d).toBeVisible();
    await page.keyboard.press('Escape'); await expect(d).toHaveCount(0);
  });

  const record = (revision, prefix, n) => ({ revision, asset_stamp: 'stamp-' + revision, project: { scenes: [{ location: '客厅', shots: Array.from({ length: Math.min(n, 2) }, (_, i) => ({ id: prefix + (i + 1), duration_ms: 3000, action: '合成动作 ' + (i + 1) })) }, ...(n > 2 ? [{ location: '走廊', shots: Array.from({ length: n - 2 }, (_, i) => ({ id: prefix + (i + 3), duration_ms: 3000, action: '合成动作 ' + (i + 3) })) }] : [])] } });
  const target = (projectId, name) => ({ projectId, name, seriesId: 's' });
  const bindingBody = (binding, extra = {}) => ({ sourceProjectId: 'e1', videoId: 'v1', videoRevision: 1, bindingRevision: binding?.revision ?? 0, binding, review: binding ? { needsReview: true, reasons: [{ category: 'action', shotIds: ['a1'] }], reviewedToRevision: null, reviewedAt: null, comparisonHash: 'h', canReview: true, disabledReason: null } : null, allowedTargets: [target('e2', '第二集'), target('e1', '第一集'), target('e3', '无分镜集')], context: null, ...extra });
  const bindingFake = (binding = null, extra = {}) => ({ projects: [{ id: 'e1', name: '第一集', series_id: 's', season_id: 'a', episode_no: 1 }, { id: 'e2', name: '第二集', series_id: 's', season_id: 'a', episode_no: 2 }, { id: 'e3', name: '无分镜集', series_id: 's', season_id: 'a', episode_no: 3 }, { id: 'x', name: '别的剧', series_id: 't', season_id: 'b', episode_no: 1 }], episodes: { e1: record(7, 'a', 4), e2: record(2, 'b', 2) }, binding: bindingBody(binding), ...extra });
  const existing = { bindingId: 'b1', revision: 3, targetProjectId: 'e1', documentId: 'd', initializedAt: 1, storyboardRevision: 5, boundAt: 1700000000000, origin: 'agent', provenance, shots: [{ shotId: 'a1', numberAtBinding: '01', durationMs: 3000, associationSeq: 1, existsInCurrent: true, currentNumber: '01' }, { shotId: 'gone', numberAtBinding: '02', durationMs: 3000, associationSeq: 2, existsInCurrent: false, currentNumber: null }, { shotId: 'a3', numberAtBinding: '03', durationMs: 3000, associationSeq: 3, existsInCurrent: true, currentNumber: '03' }] };
  const adoptedView = (name, kind = 'whole') => ({ name, sourceProjectId: 'e1', videoId: 'v1', bindingId: 'b1', kind });
  const affected = [{ projectId: 'e1', projectName: '第一集', shotId: 'a1', number: '01', before: adoptedView('片子一.mp4'), after: null }, { projectId: 'e2', projectName: '第二集', shotId: 'a1', number: '05', before: adoptedView('片子一.mp4', 'shot'), after: null }];
  const openBinding = async f => { await page.goto(origin + '/'); await page.evaluate(([value]) => window.mountBinding(value, { id: 'v1', name: '片子一.mp4' }, 'e1'), [f]); const d = page.getByRole('dialog', { name: '对应到分镜镜头' }); await expect(d).toBeVisible(); await expect(d.getByRole('region', { name: '当前绑定' })).not.toContainText('正在读取'); return d; };
  const bindingWrites = verb => fake(`fake.requests.filter(r => r.path.startsWith('/storyboard-video/') && r.method === ${JSON.stringify(verb)})`);

  await check('绑定弹窗：显示已绑定内容，选集按后端范围，先预览再按分镜顺序保存', async () => {
    const d = await openBinding(bindingFake(existing)); const now = d.getByRole('region', { name: '当前绑定' });
    await expect(now).toContainText('第 1 集 · 第一集 · 第 5 版 · 镜 01、镜 02（已不在当前稿）、镜 03'); await expect(now).toContainText('生成时记录'); await expect(now).toContainText('需复核');
    assert.deepEqual(await d.getByLabel('选集').locator('option').allTextContents(), ['第 1 集 · 第一集', '第 2 集 · 第二集', '第 3 集 · 无分镜集']);
    await expect(d.getByRole('checkbox', { name: '镜 01' })).toBeChecked(); await expect(d.getByRole('checkbox', { name: '镜 03' })).toBeChecked(); await expect(d.getByRole('checkbox', { name: '镜 02' })).not.toBeChecked();
    await d.getByRole('checkbox', { name: '镜 04' }).check(); await d.getByRole('checkbox', { name: '镜 02' }).check();
    const before = d.getByRole('definition').first(), diff = d.getByRole('definition').last(); await expect(before).toHaveText('第 1 集 · 第一集 · 第 5 版 · 镜 01、镜 02（已不在当前稿）、镜 03'); await expect(diff).toHaveText('第 1 集 · 第一集 · 第 7 版 · 镜 01、镜 02、镜 03、镜 04'); assert.ok((await before.boundingBox()).width > 300, '前后对比要整行显示'); await shotImage('binding-dialog');
    await d.getByRole('button', { name: '保存对应' }).click(); await expect(d).toHaveCount(0);
    const [preview] = await bindingWrites('POST'), [write] = await bindingWrites('PUT'); assert.ok(preview.path.endsWith('/binding/preview')); assert.ok(write.path.endsWith('/videos/v1/binding'));
    assert.deepEqual(preview.body, { action: 'bind', expectedBindingRevision: 3, targetProjectId: 'e1', expectedStoryboardRevision: 7, expectedAssetStamp: 'stamp-7', shotIds: ['a1', 'a2', 'a3', 'a4'] });
    assert.equal(write.body.previewHash, 'binding-3'); assert.equal('confirmUnbind' in write.body, false, '没有解除采用时不带确认字段'); assert.equal(await fake('fake.saved'), 1);
  });

  await check('绑定弹窗：从未绑定按修订号 0；换集清空勾选，没有分镜或没选镜头不能保存', async () => {
    const d = await openBinding(bindingFake()); await expect(d.getByRole('region', { name: '当前绑定' })).toContainText('还没有对应镜头');
    const save = d.getByRole('button', { name: '保存对应' }); await expect(save).toBeDisabled(); await d.getByRole('checkbox', { name: '镜 01' }).check(); await expect(save).toBeEnabled();
    await d.getByLabel('选集').selectOption('e2'); await expect(d.getByRole('checkbox', { name: '镜 01' })).not.toBeChecked(); await expect(save).toBeDisabled();
    await d.getByLabel('选集').selectOption('e3'); await expect(d.getByText('这一集还没有分镜。')).toBeVisible(); await expect(save).toBeDisabled();
    await expect(d.getByRole('button', { name: '解除对应' })).toHaveCount(0);
    await d.getByLabel('选集').selectOption('e2'); await d.getByRole('checkbox', { name: '镜 02' }).check(); await save.click(); await expect(d).toHaveCount(0); assert.equal((await bindingWrites('POST'))[0].body.expectedBindingRevision, 0);
  });

  await check('绑定弹窗：已绑定的集不在可选范围时能看到现状，但不能保存到那一集', async () => {
    const f = bindingFake({ ...existing, targetProjectId: 'x' }); f.episodes.x = record(2, 'x', 2); const d = await openBinding(f);
    await expect(d.getByRole('region', { name: '当前绑定' })).toContainText('第 1 集 · 别的剧'); assert.equal(await d.getByRole('option', { name: /别的剧（已不在可选范围）/ }).evaluate(o => o.disabled), true);
    await d.getByRole('checkbox', { name: '镜 02' }).check(); await expect(d.getByRole('button', { name: '保存对应' })).toBeDisabled();
  });

  await check('绑定弹窗：改绑会解除采用时列全跨集明细，确认后才带确认字段写入', async () => {
    const d = await openBinding(bindingFake(existing, { affected })); await d.getByRole('checkbox', { name: '镜 04' }).check(); await d.getByRole('button', { name: '保存对应' }).click();
    const c = d.getByRole('alertdialog', { name: '确认修改对应' }); await expect(c.getByRole('row').filter({ hasText: '第二集' })).toContainText('片子一.mp4（单镜另选）'); await expect(c.getByRole('row').filter({ hasText: '第一集' })).toContainText('未采用（播最新）'); await expect(c).toContainText('保存后：第 1 集 · 第一集 · 第 7 版'); await insideBox(c, c.getByRole('row').nth(1).getByRole('cell').nth(3)); await shotImage('binding-affected');
    await c.getByRole('button', { name: '取消' }).click(); assert.equal((await bindingWrites('PUT')).length, 0);
    await d.getByRole('button', { name: '保存对应' }).click(); await d.getByRole('alertdialog').getByRole('button', { name: '确认修改' }).click(); await expect(d).toHaveCount(0);
    const [write] = await bindingWrites('PUT'); assert.equal(write.body.confirmUnbind, true); assert.deepEqual(write.body.confirmedUnbindShotRefs, [{ projectId: 'e1', shotId: 'a1' }, { projectId: 'e2', shotId: 'a1' }]); assert.equal('confirmedUnbindShotIds' in write.body, false, '两个确认字段不能同时发');
  });

  await check('绑定弹窗：冲突时不关闭，重读并提示；解除先预览再确认，错误码有中文说明', async () => {
    const d = await openBinding(bindingFake(existing));
    await fake(`fake.fail = { code: 'VIDEO_BINDING_CONFLICT', mutate: "fake.binding.bindingRevision = 4; fake.binding.binding.revision = 4; fake.binding.binding.storyboardRevision = 6" }`);
    await d.getByRole('checkbox', { name: '镜 04' }).check(); await d.getByRole('button', { name: '保存对应' }).click();
    await expect(d.getByRole('alert')).toContainText('绑定或分镜刚被改过'); await expect(d.getByRole('region', { name: '当前绑定' })).toContainText('第 6 版');
    await d.getByRole('button', { name: '解除对应' }).click(); const c = d.getByRole('alertdialog', { name: '确认解除对应' }); await expect(c).toContainText('片子文件和视频记录不动'); assert.equal((await bindingWrites('PUT')).length, 0);
    assert.deepEqual((await bindingWrites('POST')).at(-1).body, { action: 'unbind', expectedBindingRevision: 4, targetProjectId: null, expectedStoryboardRevision: null, expectedAssetStamp: null, shotIds: [] });
    await fake(`fake.fail = { code: 'VIDEO_V2_MIGRATION_REQUIRED', status: 503 }`); await c.getByRole('button', { name: '确认解除' }).click(); await expect(d.getByRole('alert')).toContainText('片子绑定数据需要先升级');
    await d.getByRole('button', { name: '解除对应' }).click(); await d.getByRole('alertdialog').getByRole('button', { name: '确认解除' }).click(); await expect(d).toHaveCount(0); assert.equal((await bindingWrites('PUT')).at(-1).body.expectedBindingRevision, 4);
  });

  assert.deepEqual(errors, []); passed = true; console.log('全部通过');
} finally {
  await browser?.close(); await new Promise(r => server ? server.close(r) : r()); await fs.rm(temp, { recursive: true, force: true });
  if (!passed) process.exitCode = 1;
}
