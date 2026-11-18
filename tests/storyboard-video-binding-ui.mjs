// 分镜视频绑定 v2 前端界面测试：真实组件 + 合成数据 + 无头浏览器。
// 不启动拾光服务、不连真实库、不依赖后端接口；接口合同接入后的组合测试另算。
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

const bound = (shotId, durationMs, currentNumber = shotId) => ({ shotId, boundNumber: shotId, durationMs, currentNumber });
const clip = (id, boundAt, shots, extra = {}) => ({ id, name: id + '.webm', durationMs: 12000, status: 'available', mediaUrl: '/api/media/' + (extra.file ?? 'long') + '.webm', boundRevision: 3, bindingRevision: 1, boundAt, origin: 'auto', needsReview: false, reviewFields: [], review: null, shots, ...extra });
const use = (videoId, kind = 'video') => ({ videoId, videoName: videoId + '.webm', kind });
const sum = (adopted = null, extra = {}) => ({ adopted, playVideoId: adopted?.videoId ?? null, candidateCount: 2, newCount: 0, needsReview: false, ...extra });
const three = () => [bound('01', 4000), bound('02', 3000), bound('03', 5000)];
const scenario = (shots, clips) => ({ summaries: { selectionRevision: 5, shots }, clips: { selectionRevision: 5, storyboardRevision: 9, clips } });
const openShot = async (fake, shotId = '03') => { await page.goto(origin + '/'); await page.evaluate(([f, id]) => window.mountShot(f, id, id), [fake, shotId]); const d = page.getByRole('dialog', { name: '镜 ' + shotId + ' 的片子' }); await expect(d).toBeVisible(); return d; };
const fake = expr => page.evaluate(expr);
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
    const d = await openShot(scenario({ '03': sum(use('old')) }, [clip('old', 1, three()), clip('new', 9, three(), { file: 'other' })]));
    await expect(player(d)).toHaveAttribute('aria-label', '正在播放 old.webm');
    await expect.poll(() => player(d).evaluate(v => v.currentTime), { timeout: 10000 }).toBeGreaterThan(6.5);
    assert.ok(await player(d).evaluate(v => v.currentTime) < 10, '应从估算位置附近开始');
    await expect(d.getByTestId('sv-start')).toHaveText('约从 0:07 起播，按分镜时长估算，不是准确切点'); await shotImage('shot-player');
  });

  await check('规则播放：没有采用播最新，不显示新片子数', async () => {
    const d = await openShot(scenario({ '03': sum(null, { newCount: 3 }) }, [clip('old', 1, three()), clip('new', 9, three(), { file: 'other' })]));
    await expect(player(d)).toHaveAttribute('aria-label', '正在播放 new.webm'); await expect(d.getByText(/条新片子/)).toHaveCount(0);
  });

  await check('新片子到来：只被动显示 N 条，不弹框，不改变播放和采用', async () => {
    const d = await openShot(scenario({ '03': sum(use('old')) }, [clip('old', 1, three())])); const src = await player(d).getAttribute('src');
    await fake(`fake.summaries.shots['03'].newCount = 2; fake.summaries.shots['03'].playVideoId = 'old'; window.dispatchEvent(new Event('focus'))`);
    await expect(d.getByText('有 2 条新片子')).toBeVisible(); await expect(page.getByRole('alertdialog')).toHaveCount(0);
    assert.equal(await player(d).getAttribute('src'), src); assert.equal(await fake('fake.writes.length'), 0);
  });

  await check('整条采用：替换其它镜头选择时先列前后对比，取消不写，确认才写并带修订号', async () => {
    const d = await openShot(scenario({ '01': sum(use('old', 'shot')), '02': sum(), '03': sum(use('old')) }, [clip('old', 1, three()), clip('new', 9, three(), { file: 'other' })]));
    await card(d, 'new.webm').getByRole('button', { name: /^采用/ }).click();
    const confirm = page.getByRole('alertdialog', { name: '采用这条片子' }); await expect(confirm).toBeVisible();
    const row = confirm.getByRole('row').filter({ hasText: '镜 01' }); await expect(row).toContainText('old.webm（单镜另选）'); await expect(row).toContainText('new.webm（整条采用）'); await expect(confirm.getByRole('columnheader', { name: '确认后' })).toBeVisible(); await insideBox(confirm, row.getByRole('cell').nth(2)); await shotImage('adopt-confirm');
    await confirm.getByRole('button', { name: '取消' }).click(); assert.equal(await fake('fake.writes.length'), 0);
    await card(d, 'new.webm').getByRole('button', { name: /^采用/ }).click(); await page.getByRole('alertdialog').getByRole('button', { name: '确认修改' }).click();
    await expect(d.getByText('已更新采用。正在播放的片子没有变。')).toBeVisible();
    const w = await fake('fake.writes[0]'); assert.equal(w.action, 'adopt-video'); assert.equal(w.videoId, 'new'); assert.equal(w.expectedRevision, 5); assert.match(w.requestId, /^[0-9a-f-]{36}$/);
    await expect(player(d)).toHaveAttribute('aria-label', '正在播放 old.webm'); await expect(card(d, 'new.webm').getByText('已采用')).toBeVisible();
  });

  await check('单镜另选和取消采用：只动这一镜，不需要确认', async () => {
    const d = await openShot(scenario({ '01': sum(use('old')), '02': sum(use('old')), '03': sum(use('old')) }, [clip('old', 1, three()), clip('new', 9, three(), { file: 'other' })]));
    await card(d, 'new.webm').getByRole('button', { name: '只这一镜用' }).click(); await expect(card(d, 'new.webm').getByText('这一镜单独选用')).toBeVisible();
    assert.equal(await fake(`fake.summaries.shots['01'].adopted.videoId`), 'old');
    await card(d, 'new.webm').getByRole('button', { name: '取消这一镜的采用' }).click(); await expect(card(d, 'new.webm').getByText('这一镜单独选用')).toHaveCount(0);
    assert.deepEqual(await fake('fake.writes.map(w => w.action)'), ['adopt-shot', 'clear-shot']);
  });

  await check('多窗口冲突：不覆盖，重读最新结果并提示，播放不变', async () => {
    const d = await openShot(scenario({ '03': sum() }, [clip('old', 1, three()), clip('new', 9, three(), { file: 'other' })]));
    await expect(player(d)).toHaveAttribute('aria-label', '正在播放 new.webm'); const reads = await fake('fake.clipReads');
    await fake(`fake.fail = { code: 'SELECTION_CONFLICT', message: 'x', mutate: "fake.summaries.selectionRevision = 8; fake.clips.selectionRevision = 8; fake.summaries.shots['03'].adopted = { videoId: 'old', videoName: 'old.webm', kind: 'video' }" }`);
    await card(d, 'new.webm').getByRole('button', { name: '只这一镜用' }).click();
    await expect(d.getByRole('alert')).toContainText('其他窗口刚改过'); await expect(card(d, 'old.webm').getByText('已采用')).toBeVisible();
    assert.ok(await fake('fake.clipReads') > reads); await expect(player(d)).toHaveAttribute('aria-label', '正在播放 new.webm');
    await card(d, 'new.webm').getByRole('button', { name: '只这一镜用' }).click(); await expect(card(d, 'new.webm').getByText('这一镜单独选用')).toBeVisible();
    assert.equal(await fake('fake.writes[1].expectedRevision'), 8, '重试用最新修订号');
  });

  await check('写入结果未知时重试沿用同一请求编号', async () => {
    const d = await openShot(scenario({ '03': sum() }, [clip('new', 9, three())]));
    await fake(`fake.fail = { message: '网络中断', status: 0 }`); await card(d, 'new.webm').getByRole('button', { name: '只这一镜用' }).click(); await expect(d.getByRole('alert')).toContainText('网络中断');
    await card(d, 'new.webm').getByRole('button', { name: '只这一镜用' }).click(); await expect(card(d, 'new.webm').getByText('这一镜单独选用')).toBeVisible();
    assert.equal(await fake('fake.writes[0].requestId === fake.writes[1].requestId'), true);
  });

  await check('需复核：片子照常播；点已复核后标记消失、显示版本，可撤销', async () => {
    const d = await openShot(scenario({ '03': sum(use('old'), { needsReview: true }) }, [clip('old', 1, three(), { needsReview: true, reviewFields: ['action', 'duration'] }), clip('ok', 2, three())]));
    const c = card(d, 'old.webm'); await expect(player(d)).toHaveAttribute('aria-label', '正在播放 old.webm'); await expect(c.getByText('需复核')).toBeVisible(); await expect(c).toContainText('有变化：画面与人物动作、时长');
    await expect(card(d, 'ok.webm').getByRole('button', { name: '已复核' })).toHaveCount(0); await shotImage('needs-review');
    await c.getByRole('button', { name: '已复核' }).click(); await expect(c.getByText('需复核')).toHaveCount(0); await expect(c).toContainText('已复核到第 9 版');
    const w = await fake('fake.writes[0]'); assert.equal(w.action, 'mark'); assert.equal(w.storyboardRevision, 9); assert.equal(w.expectedBindingRevision, 1);
    await c.getByRole('button', { name: '撤销复核' }).click(); await expect(c.getByText('需复核')).toBeVisible(); assert.equal(await fake('fake.writes[1].action'), 'undo');
  });

  await check('媒体失效按真实状态提示，不放播放器；估算超片长时从片头播', async () => {
    let d = await openShot(scenario({ '03': sum(use('gone')) }, [clip('gone', 1, three(), { status: 'missing' })]));
    await expect(d.getByRole('alert')).toContainText('原视频文件缺失'); await expect(player(d)).toHaveCount(0);
    d = await openShot(scenario({ '03': sum() }, [clip('short', 1, three(), { durationMs: 5000 })])); await expect(d.getByTestId('sv-start')).toContainText('超过片长，已从片头播放');
    d = await openShot(scenario({ '03': { ...sum(), candidateCount: 0 } }, [])); await expect(d.getByText('这一镜还没有对应的片子')).toBeVisible(); await expect(d.getByText('到生成视频页右键片子，选「对应到分镜镜头…」。')).toBeVisible();
  });

  await check('Esc：先关确认层，再关窗口', async () => {
    const d = await openShot(scenario({ '01': sum(use('old')), '03': sum() }, [clip('new', 9, three())]));
    await card(d, 'new.webm').getByRole('button', { name: /^采用/ }).click(); await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.keyboard.press('Escape'); await expect(page.getByRole('alertdialog')).toHaveCount(0); await expect(d).toBeVisible();
    await page.keyboard.press('Escape'); await expect(d).toHaveCount(0);
  });

  const rows = (prefix, n, start = 1) => Array.from({ length: n }, (_, i) => ({ id: prefix + (i + start), number: String(i + start).padStart(2, '0'), sceneIndex: i < 2 ? 0 : 1, sceneName: i < 2 ? '客厅' : '走廊', durationMs: 3000, summary: '合成动作 ' + (i + start) }));
  const bindingFake = extra => ({ projects: [{ id: 'e1', name: '第一集', series_id: 's', season_id: 'a', episode_no: 1 }, { id: 'e2', name: '第二集', series_id: 's', season_id: 'a', episode_no: 2 }, { id: 'e3', name: '无分镜集', series_id: 's', season_id: 'a', episode_no: 3 }, { id: 'x', name: '别的剧', series_id: 't', season_id: 'b', episode_no: 1 }], episodes: { e1: { revision: 7, shots: rows('a', 4) }, e2: { revision: 2, shots: rows('b', 2) } }, binding: null, ...extra });
  const existing = { projectId: 'e1', projectName: '第一集', revision: 5, bindingRevision: 3, origin: 'auto', boundAt: 1700000000000, needsReview: true, reviewFields: ['action'], shots: [{ shotId: 'a1', boundNumber: '01', currentNumber: '01' }, { shotId: 'gone', boundNumber: '02', currentNumber: null }, { shotId: 'a3', boundNumber: '03', currentNumber: '03' }] };
  const openBinding = async f => { await page.goto(origin + '/'); await page.evaluate(([value]) => window.mountBinding(value, { id: 'v1', name: '片子一.mp4' }, 'e1'), [f]); const d = page.getByRole('dialog', { name: '对应到分镜镜头' }); await expect(d).toBeVisible(); return d; };

  await check('绑定弹窗：显示已绑定内容，只列同剧各集，保存按分镜顺序并写清前后', async () => {
    const d = await openBinding(bindingFake({ binding: existing })); const now = d.getByRole('region', { name: '当前绑定' });
    await expect(now).toContainText('第 1 集 · 第一集 · 第 5 版 · 镜 01、镜 02（已不在当前稿）、镜 03'); await expect(now).toContainText('生成时记录'); await expect(now).toContainText('需复核');
    assert.deepEqual(await d.getByLabel('选集').locator('option').allTextContents(), ['第 1 集 · 第一集', '第 2 集 · 第二集', '第 3 集 · 无分镜集']);
    await expect(d.getByRole('checkbox', { name: '镜 01' })).toBeChecked(); await expect(d.getByRole('checkbox', { name: '镜 03' })).toBeChecked(); await expect(d.getByRole('checkbox', { name: '镜 02' })).not.toBeChecked();
    await d.getByRole('checkbox', { name: '镜 04' }).check(); await d.getByRole('checkbox', { name: '镜 02' }).check();
    const before = d.getByRole('definition').first(), diff = d.getByRole('definition').last(); await expect(before).toHaveText('第 1 集 · 第一集 · 第 5 版 · 镜 01、镜 02（已不在当前稿）、镜 03'); await expect(diff).toHaveText('第 1 集 · 第一集 · 第 7 版 · 镜 01、镜 02、镜 03、镜 04'); assert.ok((await before.boundingBox()).width > 300, '前后对比要整行显示'); await shotImage('binding-dialog');
    await d.getByRole('button', { name: '保存对应' }).click(); await expect(d).toHaveCount(0);
    const w = await fake('fake.writes[0]'); assert.deepEqual(w.shotIds, ['a1', 'a2', 'a3', 'a4']); assert.equal(w.revision, 7); assert.equal(w.projectId, 'e1'); assert.equal(w.expectedBindingRevision, 3); assert.equal(await fake('fake.saved'), 1);
  });

  await check('绑定弹窗：换集清空勾选，没有分镜的集不能保存，没选镜头不能保存', async () => {
    const d = await openBinding(bindingFake({})); await expect(d.getByRole('region', { name: '当前绑定' })).toContainText('还没有对应镜头');
    const save = d.getByRole('button', { name: '保存对应' }); await expect(save).toBeDisabled(); await d.getByRole('checkbox', { name: '镜 01' }).check(); await expect(save).toBeEnabled();
    await d.getByLabel('选集').selectOption('e2'); await expect(d.getByRole('checkbox', { name: '镜 01' })).not.toBeChecked(); await expect(save).toBeDisabled();
    await d.getByLabel('选集').selectOption('e3'); await expect(d.getByText('这一集还没有分镜。')).toBeVisible(); await expect(save).toBeDisabled();
    await expect(d.getByRole('button', { name: '解除对应' })).toHaveCount(0);
  });

  await check('绑定弹窗：冲突时不关闭，重读并提示；解除要二次确认', async () => {
    const d = await openBinding(bindingFake({ binding: existing }));
    await fake(`fake.fail = { code: 'BINDING_CONFLICT', message: 'x', mutate: "fake.binding.bindingRevision = 4; fake.binding.revision = 6" }`);
    await d.getByRole('checkbox', { name: '镜 04' }).check(); await d.getByRole('button', { name: '保存对应' }).click();
    await expect(d.getByRole('alert')).toContainText('绑定或分镜刚被改过'); await expect(d.getByRole('region', { name: '当前绑定' })).toContainText('第 6 版');
    await d.getByRole('button', { name: '解除对应' }).click(); const c = d.getByRole('alertdialog', { name: '确认解除对应' }); await expect(c).toContainText('片子文件和视频记录不动'); assert.equal(await fake('fake.writes.length'), 1);
    await c.getByRole('button', { name: '确认解除' }).click(); await expect(d).toHaveCount(0); assert.equal(await fake('fake.writes[1].expectedBindingRevision'), 4);
  });

  assert.deepEqual(errors, []); passed = true; console.log('全部通过');
} finally {
  await browser?.close(); await new Promise(r => server ? server.close(r) : r()); await fs.rm(temp, { recursive: true, force: true });
  if (!passed) process.exitCode = 1;
}
