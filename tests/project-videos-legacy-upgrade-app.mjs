// PV-LEGACY-UPGRADE 真实前后端联调：不拦截任何接口。合成项目先确认“升级完成”，再在临时库里
// 去掉一条托管授权（成为可升级的旧视频）和一条读取授权（需重新定位），核对入口重现、缺授权引导、
// 有效项升级后剩余数减少、重新定位后归零才隐藏。只用临时数据目录和合成视频。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'project-videos-legacy-app-'))), clips = path.join(temp, '合成视频'); await fs.mkdir(clips);
const ffmpeg = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
async function clip(name, color) {
  const file = path.join(clips, name);
  const run = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=96x64:r=8:d=2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', file]);
  assert.equal(run.status, 0, run.stderr?.toString()); return file;
}
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const checks = [], errors = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal_item'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', SHIGUANG_AUDIO_ANALYSIS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body, method) {
  const binary = Buffer.isBuffer(body);
  const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': binary ? 'application/octet-stream' : 'application/json' }, body: binary ? body : body ? JSON.stringify(body) : undefined });
  const data = await response.json(); if (!response.ok) throw Object.assign(Error(data.error || response.status), { data }); return data;
}
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
let projectId; const pv = suffix => `/project-videos/projects/${encodeURIComponent(projectId)}${suffix}`;
async function seedVideo(file, folderId) {
  const bytes = await fs.readFile(file), requestId = crypto.randomUUID();
  await api(pv('/imports'), { requestId, folderId, fileName: path.basename(file), bytes: bytes.length, prompt: { mode: 'none' } });
  const receipt = await api(pv(`/imports/${requestId}/content`), bytes, 'PUT'); assert.equal(receipt.status, 'ready'); return receipt.videoId;
}
const work = () => page.getByRole('region', { name: '项目生成视频' });
const cards = () => work().locator('.pv-card[data-video-id]');
const banner = () => work().locator('.pv-banner', { hasText: '还不是项目托管副本' });
const modal = () => page.locator('.pv-modal');
const managedKey = id => { const h = createHash('sha256').update('project-managed-video-v1:' + id).digest('hex').slice(0, 32); return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join('-'); };
async function refresh() { await work().getByRole('button', { name: '更多视频操作' }).click(); await page.getByRole('menuitem', { name: /刷新视频资料/ }).click(); await expect(page.getByRole('menuitem')).toHaveCount(0); }
async function menuUpgrade() {
  await work().getByRole('button', { name: '更多视频操作' }).click();
  const item = page.getByRole('menuitem', { name: /升级旧视频/ }), text = await item.count() ? await item.textContent() : null;
  await page.keyboard.press('Escape'); if (await page.getByRole('menuitem').count()) await work().getByRole('button', { name: '更多视频操作' }).click();
  return text;
}
const settings = db => JSON.parse(db.prepare('SELECT data_json FROM project_video_settings WHERE id=?').get(projectId)?.data_json || '{}');

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  projectId = (await api('/projects', { name: '旧视频升级联调' })).id;
  const ids = {};
  for (const [name, color] of [['甲.mp4', 'green'], ['乙.mp4', 'brown'], ['丙.mp4', 'gray']]) ids[name] = await seedVideo(await clip(name, color), 'root');

  // 1. An empty upgrade check marks the project done (the old one-time flag).
  const empty = await api(pv('/upgrade')); assert.deepEqual(empty.items, []);
  await api(pv('/upgrade'), { requestId: crypto.randomUUID(), previewHash: empty.previewHash });
  const db = new Database(path.join(temp, 'data', 'library.sqlite'));
  await expect.poll(() => settings(db).upgradeCompleted).toBe(true);
  assert.deepEqual((await api(pv('?folderId=all'))).legacyUpgrade, { count: 0, completed: true });
  // 2. Afterwards 甲 loses its managed-copy approval (an upgradable old video) and 乙 its read authorization.
  assert.equal(db.prepare('DELETE FROM storyboard_video_approvals WHERE id=? AND project_id=?').run(managedKey(ids['甲.mp4']), projectId).changes, 1);
  assert.equal(db.prepare('DELETE FROM storyboard_video_approvals WHERE id=? AND project_id=?').run(ids['乙.mp4'], projectId).changes, 1);
  assert.deepEqual((await api(pv('?folderId=all'))).legacyUpgrade, { count: 2, completed: false });

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/#/project-videos'); await expect(work()).toBeVisible(); await page.locator('.topbar-project-slot select').selectOption(projectId);
  await work().getByRole('button', { name: '项目根目录', exact: true }).click(); await expect(cards()).toHaveCount(3);

  await check('旧的“已完成”记录仍在，入口和横幅按实际 2 个待升级重新出现', async () => {
    assert.equal(settings(db).upgradeCompleted, true, 'the stored flag is still true');
    assert.match(await menuUpgrade() || '', /2 个待升级/);
    await expect(banner()).toContainText('2 个旧视频还不是项目托管副本');
    await expect(cards().filter({ hasText: '待升级' })).toHaveCount(2);
  });

  await check('预览里缺授权的那一个引导重新定位；升级只完成有效项，剩余数减为 1', async () => {
    await banner().getByRole('button', { name: '核对并升级…' }).click();
    const items = modal().locator('.pv-upgrade-items li'); await expect(items).toHaveCount(2);
    await expect(items.filter({ hasText: '乙.mp4' })).toContainText('请先在这个视频的详情里「重新定位」');
    await expect(items.filter({ hasText: '甲.mp4' })).not.toContainText('重新定位');
    await modal().getByRole('button', { name: '确认一次，后台复制升级' }).click();
    await expect(modal().getByRole('button', { name: '重新核对剩余旧视频' })).toBeVisible({ timeout: 20000 });
    await modal().getByRole('button', { name: '返回视频列表' }).click(); await refresh();
    assert.deepEqual((await api(pv('?folderId=all'))).legacyUpgrade, { count: 1, completed: false });
    await expect(banner()).toContainText('1 个旧视频'); assert.match(await menuUpgrade() || '', /1 个待升级/);
    const list = (await api(pv('?folderId=all'))).videos;
    assert.equal(list.find(v => v.id === ids['甲.mp4']).managed, true, '甲 upgraded in place (same id)');
    assert.equal(list.find(v => v.id === ids['乙.mp4']).managed, false);
    assert.equal(list.length, 3, 'no duplicate records');
  });

  await check('乙 显式重新定位后归零，三处入口都隐藏', async () => {
    const b = (await api(pv('?folderId=all'))).videos.find(v => v.id === ids['乙.mp4']);
    const relinked = await api(pv(`/videos/${encodeURIComponent(b.id)}/relink`), { requestId: crypto.randomUUID(), expectedRevision: b.revision, path: b.path });
    assert.equal(relinked.status, 'ready', JSON.stringify(relinked));
    await refresh();
    assert.deepEqual((await api(pv('?folderId=all'))).legacyUpgrade, { count: 0, completed: true });
    assert.equal(await menuUpgrade(), null); await expect(banner()).toHaveCount(0);
    await cards().first().click(); await expect(work().getByRole('button', { name: '核对并升级…' })).toHaveCount(0);
    await expect(cards().filter({ hasText: '待升级' })).toHaveCount(0);
  });
  db.close();

  assert.deepEqual(errors, [], '页面不应出现脚本错误');
  passed = true;
} finally {
  if (!passed) { console.error(logs.slice(-3000)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'project-videos-legacy-app-failure.png') }).catch(() => {}); }
  await browser?.close(); child.kill('SIGTERM'); await exited; await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
