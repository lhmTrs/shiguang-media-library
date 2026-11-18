// 分镜视频绑定 v2 旧库升级的前后端组合测试：合成旧结构库 + 真实应用启动 + 无头浏览器，不改写接口响应。
// 覆盖：暂缓时页面可读且写入口停用、启动中断后状态可见、重启后完成、自动升级后绑定可用。不连真实库或 4317。
// 用法：npm run build && node tests/storyboard-video-binding-upgrade-ui.mjs（CREATIVE_TEST_EVIDENCE=目录 时保存截图）
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { selectProjectInBar } from './helpers/path-bar.mjs';
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
