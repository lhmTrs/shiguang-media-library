// 详情参考图：单击打开「图片设置」、双击打开大图（单击稍等再弹窗，第二下点击才能成为双击）；键盘回车立即打开设置。
// 真实本地服务 + 合成图片；不接入真实素材库。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-dblclick-')), images = path.join(temp, '合成照片'); await fs.mkdir(images);
const ffmpeg = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
const people = ['阿青', '海边'];
for (const [i, name] of people.entries()) {
  const run = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x${['aa5533', '3355aa'][i]}:s=300x400`, '-frames:v', '1', path.join(images, name + '.png')]);
  assert.equal(run.status, 0, run.stderr?.toString());
}
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const checks = [], errors = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal_item'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body, method) { const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json(); assert.ok(response.ok, p + ' ' + JSON.stringify(data)); return data; }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const work = () => page.getByRole('region', { name: '项目资产库' });
const wrap = name => work().locator('.ca-card-wrap').filter({ has: page.locator('strong', { hasText: new RegExp('^' + name + '$') }) });
const section = () => work().getByRole('region', { name: '人物属性' });
const shot = async name => { if (process.env.ATTR_SHOTS) await page.screenshot({ path: path.join(process.env.ATTR_SHOTS, name + '.png') }); };

const settingsOpen = () => page.getByRole('button', { name: '关闭图片设置' });
const viewer = () => page.getByRole('dialog', { name: '参考图片大图预览' });

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  const project = await api('/projects', { name: '双击短片' });
  await api('/roots', { path: images, kind: 'photo' }); await expect.poll(async () => (await api('/jobs')).jobs.every(j => j.status !== 'running'), { timeout: 20000 }).toBe(true);
  const listed = await api('/assets?kind=photo'), media = Object.fromEntries((listed.assets ?? listed.items).map(m => [m.name, m]));
  for (const [kind, name] of [['character', '阿青'], ['scene', '海边']]) {
    const a = await api('/project-assets/assets', { project_id: project.id, kind, name });
    const look = crypto.randomUUID(), img = crypto.randomUUID(), image = { id: img, look_id: kind === 'character' ? look : null, media_asset_id: media[name + '.png'].id, reference_type: kind === 'character' ? '人物身份' : '场景空间', purpose: '', locks: '', ignores: '', confirmed: true, archived_at: null, crop: { x: 50, y: 50, zoom: 1 }, last_known_name: name + '.png' };
    const asset = kind === 'character' ? { ...a, default_look_id: look, looks: [{ id: look, name: '日常', description: '', tags: [], default_image_id: img, archived_at: null }], images: [image] } : { ...a, default_image_id: img, images: [image] };
    await api('/project-assets/assets/' + a.id, { asset, expected_revision: a.revision }, 'PUT');
  }
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/#/project-assets'); await expect(work()).toBeVisible(); await page.getByLabel('资产所属项目').selectOption(project.id);

  for (const [tab, name] of [['人物', '阿青'], ['场景', '海边']]) {
    await check(tab + '：双击参考图打开大图，不弹「图片设置」；单击稍后打开「图片设置」；回车立即打开', async () => {
      await work().getByRole('tab', { name: new RegExp('^' + tab) }).click(); await wrap(name).locator('.ca-card').click();
      const tile = work().locator('.ca-tile-open').first(); await expect(tile).toBeVisible();
      await tile.dblclick(); await expect(viewer()).toBeVisible(); await page.waitForTimeout(400); await expect(settingsOpen()).toHaveCount(0);
      await page.keyboard.press('Escape'); await expect(viewer()).toHaveCount(0);
      await tile.click(); await expect(settingsOpen()).toBeVisible(); await expect(viewer()).toHaveCount(0);
      await settingsOpen().click(); await expect(settingsOpen()).toHaveCount(0);
      await tile.focus(); await page.keyboard.press('Enter'); await expect(settingsOpen()).toBeVisible({ timeout: 200 });
      await settingsOpen().click(); await expect(settingsOpen()).toHaveCount(0);
    });
  }

  assert.deepEqual(errors, [], '页面不应出现脚本错误');
  passed = true;
} finally {
  if (!passed) { console.error(logs.slice(-3000)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'creative-dblclick-failure.png') }).catch(() => {}); }
  await browser?.close(); child.kill('SIGTERM'); await exited; await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
