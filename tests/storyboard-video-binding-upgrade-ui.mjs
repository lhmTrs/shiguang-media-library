// 分镜视频绑定 v2 旧库升级的前后端组合测试：合成旧结构库 + 真实应用启动 + 无头浏览器，不改写接口响应。
// 覆盖：暂缓和失败时页面可读且写入口停用、启动中断后状态可见、重启后完成、自动升级后绑定可用、六主题和窄屏。不连真实库或 4317。
// 用法：npm run build && node tests/storyboard-video-binding-upgrade-ui.mjs（CREATIVE_TEST_EVIDENCE=目录 时保存截图）
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { chromium, expect } from '@playwright/test';
import { selectProjectInBar } from './helpers/path-bar.mjs';
import { lowContrast } from './helpers/contrast.mjs';
import { legacyVideoLibrary } from './helpers/video-v2-legacy-library.mjs';
import { ownedVideoServer } from './helpers/video-v2-owned-server.mjs';
import { upgradePolicy } from '../server/storyboard-video-v2/upgrade-policy.mjs';

process.env.MEDIA_DISABLE_DESKTOP_NATIVE = '1'; process.env.NODE_ENV = 'production'; // 跑构建产物，不走开发服务器
const cleanups = [], errors = []; let browser, page, passed = false;
const scope = { after: fn => cleanups.unshift(fn) };
const check = async (name, fn) => { await fn(); console.log('PASS ' + name); };
const shotImage = async name => { const dir = process.env.CREATIVE_TEST_EVIDENCE; if (dir) { await fs.mkdir(dir, { recursive: true }); await page.screenshot({ path: path.join(dir, name + '.png') }); } };
const baseOf = server => /拾光素材库 (http:\/\/127\.0\.0\.1:\d+)/.exec(server.output())[1];
const work = () => page.getByRole('region', { name: '项目生成视频' });
const card = id => work().locator(`.pv-card[data-video-id="${id}"]`);
const detail = () => work().getByRole('complementary', { name: '视频详情' });
const notice = () => work().getByRole('status').filter({ hasText: '片子绑定数据' });
async function openVideos(base, project, video) { await page.goto(base + '/?r=' + Date.now() + '#/project-videos'); await expect(work()).toBeVisible({ timeout: 15000 }); await selectProjectInBar(page, project); await expect(card(video)).toBeVisible({ timeout: 15000 }); }
async function openStory(base, project) { await page.goto(base + '/?r=' + Date.now() + '#/storyboards'); await selectProjectInBar(page, project); await expect(page.getByRole('table', { name: '可编辑分镜表' })).toBeVisible({ timeout: 15000 }); }
const mediaOk = url => page.evaluate(async u => { const r = await fetch(u, { headers: { Range: 'bytes=0-99' } }); await r.body?.cancel(); return r.status; }, url);
const insideViewport = async locator => { const box = await locator.boundingBox(), view = page.viewportSize(); assert.ok(box && box.x >= -1 && box.x + box.width <= view.width + 1, '内容超出窗口：' + JSON.stringify(box)); };
const noPageScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1).then(ok => assert.ok(ok, '页面出现横向滚动'));
const closePage = async () => { await page?.context().close(); page = null; };
const newPage = async () => { await closePage(); const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0')); page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); };

try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });

  await check('U1 暂缓的旧库：真实启动后两页可读，显示暂缓和裁剪暂停，保护写入被拒绝', async () => {
    const f = await legacyVideoLibrary(scope); await upgradePolicy({ dataDir: f.lib.dataDir, instanceId: f.instanceId, mode: 'defer', reason: '合成测试暂缓' }); await f.closeForServer();
    const server = await ownedVideoServer(f); try {
      const api = await server.ready(), base = baseOf(server), id = f.video.videoId, list = await api('/project-videos/projects/' + f.a.id); assert.equal(list.migration.status, 'deferred'); assert.equal(list.adoptionStamp, null); assert.equal(list.videos[0].adoptedShots, null);
      await newPage(); await openVideos(base, f.a.id, id); await expect(notice()).toContainText('升级已暂缓'); await expect(notice()).toContainText('分镜旧版本清理已暂停'); await expect(card(id)).toContainText('采用待确认'); await shotImage('upgrade-deferred-videos');
      assert.ok([200, 206].includes(await mediaOk(list.videos[0].mediaUrl)), '暂缓时片子仍要能播放');
      await card(id).click({ button: 'right' }); await expect(page.getByRole('menu', { name: '视频操作' }).getByRole('menuitem', { name: /对应到分镜镜头/ })).toBeDisabled(); await page.keyboard.press('Escape');
      await card(id).click(); await expect(detail()).toContainText('采用关系待确认');
      await openStory(base, f.a.id); await expect(page.locator('.sv-migration')).toContainText('升级已暂缓'); const button = page.getByRole('button', { name: '播放镜01的片子' }); await expect(button).toContainText('已暂缓'); await button.click();
      const d = page.getByRole('dialog', { name: '镜 01 的片子' }); await expect(d.getByText('暂时读不到这一镜对应的片子')).toBeVisible(); await shotImage('upgrade-deferred-player'); await d.getByRole('button', { name: '关闭' }).click();
      const refused = await api(`/storyboard-video/v2/projects/${f.a.id}/selections/preview`, { action: 'clear-shot', expectedSelectionRevision: 0, expectedStoryboardRevision: 1, shotId: 'shot_0' }).then(() => null, e => e); assert.equal(refused?.status, 503);
      for (const theme of ['forest', 'dark', 'midnight', 'sepia', 'graphite', 'ocean']) {
        await page.evaluate(t => localStorage.setItem('shiguang.theme', t), theme); await openVideos(base, f.a.id, id); await expect(notice()).toBeVisible(); await shotImage('upgrade-theme-videos-' + theme);
        assert.deepEqual(await lowContrast(page, '.pv-banner[role=status] .pv-banner-text, .pv-adoption-badge', 4.5), [], theme + ' 生成视频页状态对比度不足');
        await openStory(base, f.a.id); await expect(page.locator('.sv-migration')).toBeVisible(); await page.getByRole('button', { name: '播放镜01的片子' }).click(); const dialog = page.getByRole('dialog', { name: '镜 01 的片子' }); await expect(dialog.getByText('暂时读不到这一镜对应的片子')).toBeVisible(); await shotImage('upgrade-theme-player-' + theme);
        assert.deepEqual(await lowContrast(page, '.sv-dialog .sv-message, .sv-dialog .sv-screen strong, .sv-dialog .sv-screen span, .sv-clips h3', 4.5), [], theme + ' 播放窗状态对比度不足'); await dialog.getByRole('button', { name: '关闭' }).click();
        assert.deepEqual(await lowContrast(page, '.sv-migration', 4.5), [], theme + ' 分镜页状态对比度不足');
      }
      await page.evaluate(() => localStorage.setItem('shiguang.theme', 'forest'));
      // 分镜页默认窄屏时两个侧栏会盖住主表（main 已有布局）：先在宽屏收起，再看状态提示和播放窗。
      await openStory(base, f.a.id); await page.getByRole('button', { name: '关闭镜头详情' }).click(); await page.getByRole('button', { name: '隐藏场景目录' }).click(); await page.setViewportSize({ width: 390, height: 844 });
      await insideViewport(page.locator('.sv-migration')); await page.getByRole('button', { name: '播放镜01的片子' }).click(); const narrow = page.getByRole('dialog', { name: '镜 01 的片子' }); await insideViewport(narrow); await expect(narrow.getByText('暂时读不到这一镜对应的片子')).toBeVisible(); await shotImage('upgrade-narrow-player'); await narrow.getByRole('button', { name: '关闭' }).click();
      await openVideos(base, f.a.id, id); await insideViewport(notice()); await noPageScroll(); await shotImage('upgrade-narrow-videos'); await page.setViewportSize({ width: 1440, height: 900 });
    } finally { await closePage(); await server.stop(); }
  });

  await check('U2 启动中断的旧库：页面显示未完成，重启后状态提示消失，绑定恢复可用', async () => {
    const f = await legacyVideoLibrary(scope); await f.closeForServer(); const id = f.video.videoId; let server = await ownedVideoServer(f, { phase: 'delete' });
    try {
      const api = await server.ready(), base = baseOf(server), state = await api(`/storyboard-video/v2/projects/${f.a.id}/state`); assert.notEqual(state.migration.status, 'complete');
      await newPage(); await openVideos(base, f.a.id, id); await expect(notice()).toBeVisible(); await expect(card(id)).toContainText('采用待确认'); await shotImage('upgrade-interrupted-videos');
    } finally { await closePage(); await server.stop(); }
    server = await ownedVideoServer(f); try {
      const api = await server.ready(), base = baseOf(server); assert.equal((await api(`/storyboard-video/v2/projects/${f.a.id}/state`)).migration.status, 'complete'); await newPage(); await openVideos(base, f.a.id, id); await expect(notice()).toHaveCount(0); await expect(card(id)).not.toContainText('采用待确认');
      await card(id).click({ button: 'right' }); await page.getByRole('menu', { name: '视频操作' }).getByRole('menuitem', { name: /对应到分镜镜头/ }).click(); const b = page.getByRole('dialog', { name: '对应到分镜镜头' }); await b.getByRole('checkbox', { name: '镜 01' }).check(); await b.getByRole('button', { name: '保存对应' }).click(); await expect(b).toHaveCount(0);
      assert.deepEqual((await api(`/storyboard-video/v2/source-projects/${f.a.id}/videos/${id}/binding`)).binding.shots.map(s => s.numberAtBinding), ['01']);
    } finally { await closePage(); await server.stop(); }
  });

  await check('U4 升级失败的旧库：真实启动失败后页面可读、片子可播，写入被拒绝；排除故障后重启完成', async () => {
    const f = await legacyVideoLibrary(scope); f.db.exec("CREATE TRIGGER fail_startup BEFORE DELETE ON storyboard_video_plans BEGIN SELECT RAISE(ABORT,'synthetic delete failure');END"); await f.closeForServer(); const id = f.video.videoId; let server = await ownedVideoServer(f);
    try {
      const api = await server.ready(), base = baseOf(server), list = await api('/project-videos/projects/' + f.a.id); assert.equal(list.migration.status, 'failed'); assert.equal(list.videos[0].adoptedShots, null); await newPage(); await openVideos(base, f.a.id, id);
      await expect(notice()).toContainText('升级失败'); await expect(card(id)).toContainText('采用待确认'); assert.ok([200, 206].includes(await mediaOk(list.videos[0].mediaUrl))); await shotImage('upgrade-failed-videos');
      await openStory(base, f.a.id); await expect(page.locator('.sv-migration')).toContainText('升级失败'); await expect(page.getByRole('button', { name: '播放镜01的片子' })).toContainText('升级失败');
      const refused = await api(`/storyboard-video/v2/source-projects/${f.a.id}/videos/${id}/binding/preview`, { action: 'unbind', expectedBindingRevision: 0, targetProjectId: null, expectedStoryboardRevision: null, expectedAssetStamp: null, shotIds: [] }).then(() => null, e => e); assert.equal(refused?.status, 503);
    } finally { await closePage(); await server.stop(); }
    const db = new Database(path.join(f.lib.dataDir, 'library.sqlite')); db.exec('DROP TRIGGER fail_startup'); db.close(); server = await ownedVideoServer(f);
    try { const api = await server.ready(); assert.equal((await api('/project-videos/projects/' + f.a.id)).migration.status, 'complete'); } finally { await server.stop(); }
  });

  await check('U3 没有暂缓的旧库：首次启动自动完成，分镜页没有状态提示', async () => {
    const f = await legacyVideoLibrary(scope); await f.closeForServer(); const server = await ownedVideoServer(f);
    try { const api = await server.ready(), base = baseOf(server); assert.equal((await api('/project-videos/projects/' + f.a.id)).migration.status, 'complete'); await newPage(); await openStory(base, f.a.id); await expect(page.locator('.sv-migration')).toHaveCount(0); await expect(page.getByRole('button', { name: '播放镜01的片子' })).not.toContainText('待升级'); }
    finally { await closePage(); await server.stop(); }
  });

  assert.deepEqual(errors, []); passed = true; console.log('ALL PASS storyboard-video-binding-upgrade-ui');
} finally {
  await browser?.close();
  for (const fn of cleanups) await fn();
  if (!passed) process.exitCode = 1;
}
