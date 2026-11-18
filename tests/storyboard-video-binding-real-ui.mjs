// 分镜视频绑定 v2 前后端组合测试：真实本地服务（全新合成库）+ 真实视频文件 + 无头浏览器，不拦截接口。
// 覆盖：右键绑定、点镜播放、整条采用、被动新片子、替换确认、多窗口冲突、需复核与已复核、改绑解除采用、
// 解除对应、跨集同镜头 ID 的废片确认、移除和覆盖的解除确认、六主题和窄屏。不连真实库、4317、平台或模型。
// 用法：npm run build && node tests/storyboard-video-binding-real-ui.mjs（CREATIVE_TEST_EVIDENCE=目录 时保存截图）
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { randomUUID as rid } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { selectProjectInBar } from './helpers/path-bar.mjs';
import { syntheticSource } from './helpers/storyboard-fixture.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'video-binding-real-ui-')));
const s0 = net.createServer(); await new Promise(r => s0.listen(0, '127.0.0.1', r)); const port = s0.address().port; await new Promise(r => s0.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, library, passed = false; const errors = [], foreign = [], writes = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production', MEDIA_CONTAINER: '0', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'item'), MEDIA_PERSONAL_VIDEO_DIR: path.join(temp, 'video'), CODEX_HOME: path.join(temp, 'codex'), MEDIA_UPDREAM_QUEUE_DIR: path.join(temp, 'no-queue'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_CODEX_AUTOCONNECT: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', (code, signal) => r({ code, signal })));

const headers = () => ({ cookie, origin, 'x-local-token': token, 'x-shiguang-library-id': library });
async function api(p, body, method) {
  const r = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { ...headers(), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json(); if (!r.ok) throw Object.assign(Error(p + ' ' + r.status + ' ' + JSON.stringify(d).slice(0, 300)), { status: r.status, data: d }); return d;
}
const check = async (name, fn) => { await fn(); console.log('PASS ' + name); };
const shotImage = async name => { const dir = process.env.CREATIVE_TEST_EVIDENCE; if (!dir) return; await fs.mkdir(dir, { recursive: true }); await page.screenshot({ path: path.join(dir, name + '.png') }); };
const v2 = '/storyboard-video/v2';
const state = project => api(`${v2}/projects/${project}/state`);
const adoptedOf = async (project, shotId) => (await state(project)).shots.find(s => s.shotId === shotId)?.adopted ?? null;
const bindingPath = (source, video) => `${v2}/source-projects/${source}/videos/${video}/binding`;

/** 另一个窗口或 Agent 走同一套接口写入。 */
async function bindByApi(source, video, target, shotIds) {
  const { bindingRevision } = await api(bindingPath(source, video)), board = await api('/storyboard/projects/' + target);
  const intent = { action: 'bind', expectedBindingRevision: bindingRevision, targetProjectId: target, expectedStoryboardRevision: board.revision, expectedAssetStamp: board.asset_stamp, shotIds };
  const preview = await api(bindingPath(source, video) + '/preview', intent);
  return api(bindingPath(source, video), { ...intent, requestId: rid(), previewHash: preview.previewHash, ...(preview.requiresConfirmation ? { confirmUnbind: true, confirmedUnbindShotRefs: preview.affectedShots.map(s => ({ projectId: s.projectId, shotId: s.shotId })) } : {}) }, 'PUT');
}
async function selectByApi(project, action, source, video, shotId) {
  const { context } = await state(project), { binding, bindingRevision } = await api(bindingPath(source, video));
  const intent = { action, expectedSelectionRevision: context.selectionRevision, expectedStoryboardRevision: context.storyboardRevision, sourceProjectId: source, videoId: video, bindingId: binding.bindingId, expectedBindingRevision: bindingRevision, ...(shotId ? { shotId } : {}) };
  const preview = await api(`${v2}/projects/${project}/selections/preview`, intent);
  return api(`${v2}/projects/${project}/selections`, { ...intent, requestId: rid(), previewHash: preview.previewHash, ...(preview.requiresConfirmation ? { confirmReplace: true } : {}) });
}
async function agentSave(project, edit) {
  const current = await api('/storyboard/projects/' + project), next = structuredClone(current.project); edit(next);
  return api('/storyboard/projects/' + project, { project: next, expected_revision: current.revision, change: { author: 'agent', reason_category: 'prompt_wrong', reason_text: '合成改动' }, request_id: rid() }, 'PUT');
}
function source(durations) {
  const value = syntheticSource(), first = value.scenes[0].shots[0];
  value.scenes[0].shots = durations.map((duration_ms, i) => ({ ...structuredClone(first), id: 'shot_' + i, dialogue: [], duration_ms }));
  value.segments[0].start_shot_id = 'shot_0'; return value;
}
async function makeVideo(name, color, dir = 'clips-' + color) {
  await fs.mkdir(path.join(temp, dir), { recursive: true });
  const file = path.join(temp, dir, name), run = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=96x64:r=8:d=12`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '8', '-threads', '1', file]);
  assert.equal(run.status, 0, String(run.stderr)); return file;
}
async function importVideo(project, name, color, folderId) {
  const bytes = await fs.readFile(await makeVideo(name, color)), requestId = rid();
  await api(`/project-videos/projects/${project}/imports`, { requestId, fileName: name, bytes: bytes.length, prompt: { mode: 'none' }, ...(folderId ? { folderId } : {}) });
  const response = await fetch(`${origin}/api/project-videos/projects/${project}/imports/${requestId}/content`, { method: 'PUT', headers: { ...headers(), 'content-type': 'application/octet-stream' }, body: bytes }), receipt = await response.json();
  assert.equal(receipt.status, 'ready', JSON.stringify(receipt)); return receipt.videoId;
}

const work = () => page.getByRole('region', { name: '项目生成视频' });
const videoCard = id => work().locator(`.pv-card[data-video-id="${id}"]`);
const modal = () => page.locator('.pv-modal');
const openStory = async id => { await page.goto(origin + '/?r=' + Date.now() + '#/storyboards'); await selectProjectInBar(page, id); await expect(page.getByRole('table', { name: '可编辑分镜表' })).toBeVisible({ timeout: 15000 }); };
const openVideos = async id => { await page.goto(origin + '/?r=' + Date.now() + '#/project-videos'); await expect(work()).toBeVisible(); await selectProjectInBar(page, id); await expect(work().locator('.pv-card[data-video-id]').first()).toBeVisible({ timeout: 15000 }); };
const shotButton = n => page.getByRole('button', { name: '播放镜' + n + '的片子' });
const row = n => page.getByTestId('shot-row-' + n);
const openShot = async n => { await shotButton(n).click(); const d = page.getByRole('dialog', { name: '镜 ' + n + ' 的片子' }); await expect(d.getByRole('heading', { name: /这一镜的片子 · / })).toBeVisible({ timeout: 10000 }); return d; };
const clip = (d, name) => d.locator('.sv-clip').filter({ hasText: name });
const openBinding = async id => { await videoCard(id).click({ button: 'right' }); await page.getByRole('menu', { name: '视频操作' }).getByRole('menuitem', { name: '对应到分镜镜头…' }).click(); const d = page.getByRole('dialog', { name: '对应到分镜镜头' }); await expect(d.getByRole('region', { name: '当前绑定' })).not.toContainText('正在读取', { timeout: 10000 }); return d; };
const insideViewport = async locator => { const box = await locator.boundingBox(), view = page.viewportSize(); assert.ok(box && box.x >= -1 && box.y >= -1 && box.x + box.width <= view.width + 1 && box.y + box.height <= view.height + 1, '内容超出窗口：' + JSON.stringify(box)); };
const noSideScroll = locator => locator.evaluate(el => el.scrollWidth <= el.clientWidth + 1).then(ok => assert.ok(ok, '出现横向滚动'));
/** 文字和实际背景的对比度，按 WCAG 公式计算。 */
const lowContrast = (selector, minimum) => page.evaluate(([css, min]) => {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const rgba = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data; return [r, g, b, a / 255]; };
  const over = (top, under) => top.slice(0, 3).map((value, i) => value * top[3] + under[i] * (1 - top[3]));
  const backdrop = el => { const layers = []; for (let node = el; node; node = node.parentElement) { const c = rgba(getComputedStyle(node).backgroundColor); if (c[3]) layers.push(c); if (c[3] === 1) break; } return layers.reverse().reduce((under, top) => over(top, under), [255, 255, 255]); };
  const light = c => { const [r, g, b] = c.map(v => { const x = v / 255; return x <= .03928 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
  return [...document.querySelectorAll(css)].filter(el => el.textContent.trim() && el.getClientRects().length).flatMap(el => {
    const bg = backdrop(el), fg = over(rgba(getComputedStyle(el).color), bg), [a, b] = [light(fg), light(bg)].sort((x, y) => y - x), ratio = (a + .05) / (b + .05);
    return ratio < min ? [el.className + ':' + el.textContent.trim().slice(0, 16) + ':' + ratio.toFixed(2)] : [];
  });
}, [selector, minimum]);

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const session = await fetch(origin + '/api/session'), auth = await session.json(); cookie = session.headers.get('set-cookie').split(';')[0]; token = auth.token; library = auth.instanceId;
  const series = await api('/project-series', { name: '合成剧', software: 'jianying', request_id: rid() }), season = await api(`/project-series/${series.id}/seasons`, { request_id: rid() });
  const episodes = []; for (let i = 1; i <= 2; i++) episodes.push((await api(`/project-series/${series.id}/episodes`, { season_id: season.id, expected_episode_no: i, request_id: rid() })).project);
  const [one, two] = episodes;
  await api(`/storyboard/projects/${one.id}/initialize`, { request_id: rid(), source: source([4000, 3000, 5000]), expected_revision: null, filename: '一.json', timing: 'duration' });
  await api(`/storyboard/projects/${two.id}/initialize`, { request_id: rid(), source: source([2000, 2000]), expected_revision: null, filename: '二.json', timing: 'duration' });
  const alpha = await importVideo(one.id, 'alpha.mp4', 'navy'), beta = await importVideo(one.id, 'beta.mp4', 'maroon'), gamma = await importVideo(one.id, 'gamma.mp4', 'teal');

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => { localStorage.setItem('shiguang.refreshSeconds', '0'); });
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { const u = new URL(r.url()); if (u.origin !== origin && !['data:', 'blob:'].includes(u.protocol)) foreign.push(r.url()); if (r.method() !== 'GET' && u.pathname.startsWith('/api/')) writes.push({ method: r.method(), path: u.pathname, body: r.postDataJSON?.() }); });

  await check('R1 生成视频页右键绑定：按后端范围列同剧两集，保存后真实写入，手动补录没有生成出处', async () => {
    await openVideos(one.id); const d = await openBinding(alpha); await expect(d.getByRole('region', { name: '当前绑定' })).toContainText('还没有对应镜头');
    assert.equal(await d.getByLabel('选集').locator('option').count(), 2);
    for (const n of ['03', '01', '02']) await d.getByRole('checkbox', { name: '镜 ' + n }).check();
    await shotImage('r1-binding'); await d.getByRole('button', { name: '保存对应' }).click(); await expect(d).toHaveCount(0);
    const { binding } = await api(bindingPath(one.id, alpha)); assert.deepEqual(binding.shots.map(s => s.shotId), ['shot_0', 'shot_1', 'shot_2']); assert.equal(binding.origin, 'manual'); assert.equal(binding.provenance, null);
  });

  await check('R2 点镜播放：播真实片子，按绑定版时长估算起播，并写清手动补录', async () => {
    await openStory(one.id); await expect(shotButton('03')).toContainText('播放'); const d = await openShot('03'), player = d.locator('video');
    await expect(player).toHaveAttribute('aria-label', /alpha/); await expect.poll(() => player.evaluate(v => v.currentTime), { timeout: 10000 }).toBeGreaterThan(6.5);
    await expect(d.getByTestId('sv-start')).toContainText('约从 0:07 起播'); await expect(clip(d, 'alpha')).toContainText('手动补录到第 1 版分镜 · 没有生成出处'); await shotImage('r2-player');
  });

  await check('R3 整条采用：没有替换时直接写入，覆盖的三镜一起采用，播放不变', async () => {
    const d = page.getByRole('dialog', { name: '镜 03 的片子' }), src = await d.locator('video').getAttribute('src');
    await clip(d, 'alpha').getByRole('button', { name: /^采用/ }).click(); await expect(d.getByText('已更新采用。正在播放的片子没有变。')).toBeVisible();
    await expect(page.getByRole('alertdialog')).toHaveCount(0); await expect(clip(d, 'alpha').getByText('已采用')).toBeVisible(); assert.equal(await d.locator('video').getAttribute('src'), src);
    for (const id of ['shot_0', 'shot_1', 'shot_2']) { const a = await adoptedOf(one.id, id); assert.equal(a.videoId, alpha); assert.equal(a.kind, 'whole'); }
  });

  await check('R4 新片子到来：只被动显示数量，不弹框，不换播放和采用', async () => {
    const d = page.getByRole('dialog', { name: '镜 03 的片子' }), src = await d.locator('video').getAttribute('src');
    await bindByApi(one.id, beta, one.id, ['shot_2']); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(d.getByText('有 1 条新片子')).toBeVisible({ timeout: 10000 }); await expect(page.getByRole('alertdialog')).toHaveCount(0);
    assert.equal(await d.locator('video').getAttribute('src'), src); assert.equal((await adoptedOf(one.id, 'shot_2')).videoId, alpha);
    await d.getByRole('button', { name: '关闭' }).click(); await expect(row('03')).toContainText('有 1 条新片子'); await expect(row('01')).not.toContainText('条新片子');
  });

  await check('R5 单镜另选：后端预览要求确认，前后写全，取消不写，确认后只动这一镜', async () => {
    const d = await openShot('03'); await expect(d.locator('video')).toHaveAttribute('aria-label', /alpha/);
    await clip(d, 'beta').getByRole('button', { name: '只这一镜用' }).click(); let c = page.getByRole('alertdialog', { name: '这一镜改用这条片子' });
    await expect(c.getByRole('row').filter({ hasText: '镜 03' })).toContainText('alpha'); await expect(c).toContainText('（单镜另选）'); await shotImage('r5-confirm');
    await c.getByRole('button', { name: '取消' }).click(); assert.equal((await adoptedOf(one.id, 'shot_2')).videoId, alpha);
    await clip(d, 'beta').getByRole('button', { name: '只这一镜用' }).click(); c = page.getByRole('alertdialog', { name: '这一镜改用这条片子' }); await c.getByRole('button', { name: '确认修改' }).click();
    await expect(clip(d, 'beta').getByText('这一镜单独选用')).toBeVisible(); assert.equal((await adoptedOf(one.id, 'shot_2')).kind, 'shot'); assert.equal((await adoptedOf(one.id, 'shot_0')).videoId, alpha);
    await expect(d.locator('video')).toHaveAttribute('aria-label', /alpha/, { timeout: 2000 });
  });

  await check('R6 多窗口冲突：真实 409 不覆盖，重读后可按新修订号重试', async () => {
    const d = page.getByRole('dialog', { name: '镜 03 的片子' }); await selectByApi(one.id, 'adopt-shot', one.id, alpha, 'shot_1');
    await clip(d, 'alpha').getByRole('button', { name: '只这一镜用' }).click(); await expect(d.getByRole('alert')).toContainText('其他窗口刚改过'); assert.equal((await adoptedOf(one.id, 'shot_2')).videoId, beta);
    await clip(d, 'alpha').getByRole('button', { name: '只这一镜用' }).click(); await page.getByRole('alertdialog').getByRole('button', { name: '取消' }).click(); assert.equal((await adoptedOf(one.id, 'shot_2')).videoId, beta);
    await d.getByRole('button', { name: '关闭' }).click();
  });

  await check('R7 需复核：改进提示词的内容后主表和播放窗都有标记，已复核后消失，可撤销', async () => {
    await agentSave(one.id, p => { p.scenes[0].shots[2].action = '合成：改过的画面与动作。'; }); await openStory(one.id); await expect(row('03')).toContainText('需复核', { timeout: 10000 });
    const d = await openShot('03'), c = clip(d, 'alpha'); await expect(c.getByText('需复核')).toBeVisible(); await expect(c).toContainText('画面与人物动作'); await expect(d.locator('video')).toBeVisible(); await shotImage('r7-review');
    await c.getByRole('button', { name: '已复核' }).click(); await expect(c.getByText('需复核')).toHaveCount(0); await expect(c).toContainText('已复核到第 2 版');
    await c.getByRole('button', { name: '撤销复核' }).click(); await expect(c.getByText('需复核')).toBeVisible(); await c.getByRole('button', { name: '已复核' }).click(); await expect(c).toContainText('已复核到第 2 版');
    const { binding, review } = await api(bindingPath(one.id, alpha)); assert.equal(binding.origin, 'manual'); assert.equal(binding.provenance, null); assert.equal(review.reviewedToRevision, 2);
    await agentSave(one.id, p => { p.scenes[0].shots[2].camera = '合成：改过的摄影机设计。'; }); assert.equal((await api(bindingPath(one.id, alpha))).review.needsReview, true, '之后再改要重新挂标记');
    await d.getByRole('button', { name: '关闭' }).click();
  });

  await check('R8 六主题：播放窗、确认层和绑定弹窗的文字可读，不超出窗口', async () => {
    for (const theme of ['forest', 'dark', 'midnight', 'sepia', 'graphite', 'ocean']) {
      await page.evaluate(t => localStorage.setItem('shiguang.theme', t), theme); await openStory(one.id); const d = await openShot('03');
      await clip(d, 'alpha').getByRole('button', { name: '只这一镜用' }).click(); const c = page.getByRole('alertdialog'); await expect(c).toBeVisible(); await insideViewport(d); await insideViewport(c); await shotImage('theme-player-' + theme);
      assert.deepEqual(await lowContrast('.sv-dialog h2, .sv-clip strong, .sv-clip p, .sv-tags span, .sv-now small, .sv-actions button, .sv-confirm h3, .sv-confirm th, .sv-confirm td', 4.5), [], theme + ' 播放窗对比度不足');
      await c.getByRole('button', { name: '取消' }).click(); await d.getByRole('button', { name: '关闭' }).click();
      await openVideos(one.id); const b = await openBinding(alpha); await insideViewport(b); await shotImage('theme-binding-' + theme);
      assert.deepEqual(await lowContrast('.pv-binding-video, .pv-binding-now p, .pv-binding-now small, .pv-binding-review, .pv-binding-shot strong, .pv-binding-shot small, .pv-binding-shot span', 4.5), [], theme + ' 绑定弹窗对比度不足');
      await b.getByRole('button', { name: '取消' }).click();
    }
    await page.evaluate(() => localStorage.setItem('shiguang.theme', 'forest'));
  });

  await check('R9 窄屏 390：播放窗和确认层不横向溢出，按钮可用', async () => {
    // 主表窄屏时两个侧栏会盖住表格，这是分镜页原有布局：先在宽屏收起，再看播放窗本身。
    await openStory(one.id); await page.getByRole('button', { name: '关闭镜头详情' }).click(); await page.getByRole('button', { name: '隐藏场景目录' }).click(); await page.setViewportSize({ width: 390, height: 844 }); const d = await openShot('03'); await insideViewport(d); await noSideScroll(d); await noSideScroll(d.locator('.sv-body')); await shotImage('narrow-player');
    await clip(d, 'alpha').getByRole('button', { name: '只这一镜用' }).click(); const c = page.getByRole('alertdialog'); await insideViewport(c); await noSideScroll(c); await shotImage('narrow-confirm'); await c.getByRole('button', { name: '取消' }).click(); await d.getByRole('button', { name: '关闭' }).click();
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await check('R10 改绑：真实预览列出要解除的采用，确认后用复合引用写入，不自动采用新目标', async () => {
    await openVideos(one.id); const d = await openBinding(alpha); await expect(d.getByRole('region', { name: '当前绑定' })).toContainText('需复核');
    await d.getByRole('checkbox', { name: '镜 02' }).uncheck(); await d.getByRole('checkbox', { name: '镜 03' }).uncheck(); await d.getByRole('button', { name: '保存对应' }).click();
    const c = d.getByRole('alertdialog', { name: '确认修改对应' }), line = c.getByRole('row').filter({ hasText: '镜 02' }); await expect(line).toContainText('alpha'); await expect(line).toContainText('未采用（播最新）'); await expect(c.getByRole('button', { name: '确认修改' })).toBeInViewport();
    await page.setViewportSize({ width: 390, height: 844 }); await expect(c.getByRole('button', { name: '确认修改' })).toBeVisible(); await noSideScroll(c); await shotImage('narrow-binding-confirm'); await page.setViewportSize({ width: 1440, height: 900 });
    writes.length = 0; await c.getByRole('button', { name: '确认修改' }).click(); await expect(d).toHaveCount(0);
    const put = writes.find(w => w.method === 'PUT' && w.path.endsWith('/binding')); assert.ok(put.body.confirmedUnbindShotRefs.some(r => r.projectId === one.id && r.shotId === 'shot_1')); assert.equal('confirmedUnbindShotIds' in put.body, false);
    assert.equal(await adoptedOf(one.id, 'shot_1'), null); assert.deepEqual((await api(bindingPath(one.id, alpha))).binding.shots.map(s => s.shotId), ['shot_0']);
  });

  await check('R11 解除对应：先预览再确认，片子记录还在，采用已清', async () => {
    await page.reload(); await expect(videoCard(beta)).toBeVisible({ timeout: 15000 }); const d = await openBinding(beta); await d.getByRole('button', { name: '解除对应' }).click();
    const c = d.getByRole('alertdialog', { name: '确认解除对应' }); await expect(c).toContainText('片子文件和视频记录不动'); await expect(c.getByRole('row').filter({ hasText: '镜 03' })).toContainText('beta'); await c.getByRole('button', { name: '确认解除' }).click(); await expect(d).toHaveCount(0);
    assert.equal((await api(bindingPath(one.id, beta))).binding, null); assert.equal(await adoptedOf(one.id, 'shot_2'), null); await expect(videoCard(beta)).toBeVisible();
  });

  await check('R12 跨集同镜头 ID：详情写清是哪一集，移入废片时两集都列出并按集确认', async () => {
    if (!await adoptedOf(one.id, 'shot_0')) await selectByApi(one.id, 'adopt-video', one.id, alpha);
    await bindByApi(one.id, gamma, two.id, ['shot_0']); await selectByApi(two.id, 'adopt-video', one.id, gamma);
    await page.reload(); await expect(videoCard(gamma)).toBeVisible({ timeout: 15000 }); await videoCard(gamma).click(); await expect(work().getByRole('complementary', { name: '视频详情' })).toContainText(two.name + '：镜 01');
    await videoCard(alpha).click(); await videoCard(gamma).click({ modifiers: ['Meta'] }); await work().getByRole('toolbar', { name: '已选视频操作' }).getByRole('button', { name: '标记为废片' }).click(); await expect(modal()).toContainText('标记为废片（2 个）');
    await modal().getByRole('button', { name: '核对影响' }).click(); await modal().getByLabel('确认设置废片收纳处').check(); await modal().getByRole('button', { name: /创建|设为收纳处/ }).last().click(); await modal().getByRole('button', { name: /继续：核对移入影响/ }).click();
    await expect(modal()).toContainText(one.name + '：镜 01', { timeout: 10000 }); await expect(modal()).toContainText(two.name + '：镜 01'); await shotImage('r12-cross-episode');
    writes.length = 0; await modal().getByLabel('我已核对上述镜号，确认解除这些采用关系').check(); await modal().getByRole('button', { name: /移入废片/ }).last().click(); await expect(modal()).toContainText('已移入废片：2 个视频', { timeout: 15000 });
    const body = writes.find(w => w.path.endsWith('/operations') && w.body?.confirmUnbind).body; assert.deepEqual(body.confirmedUnbindShotRefs.map(r => r.projectId + ':' + r.shotId).sort(), [one.id + ':shot_0', two.id + ':shot_0'].sort()); assert.equal('confirmedUnbindShotIds' in body, false);
    assert.equal(await adoptedOf(one.id, 'shot_0'), null); assert.equal(await adoptedOf(two.id, 'shot_0'), null);
  });

  const adoptedVideo = async (name, color, shotId, folderId) => { const id = await importVideo(one.id, name, color, folderId); await bindByApi(one.id, id, one.id, [shotId]); await selectByApi(one.id, 'adopt-video', one.id, id); return id; };
  const confirmedRefs = body => (body.confirmedUnbindShotRefs ?? []).map(r => r.projectId + ':' + r.shotId);

  await check('R13 移除视频记录：受影响镜头写清集名，带完整确认后真实解除采用', async () => {
    const id = await adoptedVideo('epsilon.mp4', 'olive', 'shot_1'); await openVideos(one.id); await videoCard(id).click();
    await work().getByRole('complementary', { name: '视频详情' }).getByRole('button', { name: '视频操作' }).click(); await page.getByRole('menuitem', { name: /移除视频记录/ }).click(); await expect(modal()).toContainText(one.name + '：镜 02');
    writes.length = 0; await modal().getByRole('button', { name: '确认移除并解除关联' }).click(); await expect(modal()).toHaveCount(0, { timeout: 10000 });
    assert.deepEqual(confirmedRefs(writes.find(w => w.path.endsWith('/remove')).body), [one.id + ':shot_1']); assert.equal(await adoptedOf(one.id, 'shot_1'), null);
  });

  await check('R14 导入覆盖同名视频：列出受影响镜头，带完整确认后真实解除采用', async () => {
    await adoptedVideo('delta.mp4', 'purple', 'shot_1'); const replacement = await makeVideo('delta.mp4', 'orange', 'replacement'); await openVideos(one.id);
    await work().getByRole('button', { name: '导入视频' }).click(); await page.locator('input[type=file].pv-sr-only').setInputFiles(replacement); const go = modal().locator('form button[type=submit]');
    await go.click(); await go.click(); await expect(modal().getByLabel('同名目标视频')).toBeVisible({ timeout: 15000 }); await expect(modal()).toContainText(one.name + '：镜 02');
    writes.length = 0; await modal().locator('.pv-check input').check(); await modal().getByRole('button', { name: '确认覆盖同名目标' }).click(); await expect.poll(() => adoptedOf(one.id, 'shot_1'), { timeout: 15000 }).toBeNull();
    assert.deepEqual(confirmedRefs(writes.find(w => w.path.endsWith('/resolve')).body), [one.id + ':shot_1']);
  });

  await check('R15 单个视频移动并覆盖同名目标：确认后真实解除目标的采用', async () => {
    const folder = await api(`/project-videos/projects/${one.id}/folders`, { requestId: rid(), name: '合成子目录', parentId: 'root' }); await adoptedVideo('zeta.mp4', 'gray', 'shot_1', folder.id);
    const source = await importVideo(one.id, 'zeta.mp4', 'pink'); await openVideos(one.id); await expect(videoCard(source)).toBeVisible();
    await videoCard(source).click({ button: 'right' }); await page.getByRole('menu', { name: '视频操作' }).getByRole('menuitem', { name: /移动到/ }).click();
    await modal().getByLabel('目标文件夹').selectOption(folder.id); await modal().getByRole('button', { name: '核对操作影响' }).click(); await modal().getByLabel(/^冲突处理/).selectOption('overwrite', { timeout: 10000 }); await modal().getByRole('button', { name: '重新核对影响' }).click();
    await expect(modal()).toContainText(one.name + '：镜 02', { timeout: 10000 }); writes.length = 0; await modal().getByLabel('我已核对上述镜号，确认解除这些采用关系').check(); await modal().getByRole('button', { name: '确认执行' }).click(); await expect.poll(() => adoptedOf(one.id, 'shot_1'), { timeout: 15000 }).toBeNull();
    assert.deepEqual(confirmedRefs(writes.find(w => w.path.endsWith('/operations') && w.body?.confirmUnbind).body), [one.id + ':shot_1']);
  });

  assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
  passed = true; console.log('ALL PASS storyboard-video-binding-real-ui');
} finally {
  await browser?.close();
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); const r = await Promise.race([exited, new Promise(x => setTimeout(() => x('timeout'), 20000))]); if (r === 'timeout') { console.log('服务没有在 20 秒内正常退出'); passed = false; } }
  if (passed && !logs.includes('APPLICATION_CLOSED_KNOWN')) { console.log('没有正常关闭'); passed = false; }
  await fs.rm(temp, { recursive: true, force: true });
  if (!passed) { console.log(logs.slice(-2500)); process.exitCode = 1; }
}
