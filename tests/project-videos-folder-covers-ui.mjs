// 生成视频 · 文件夹卡片封面与空态（合同 PV-FOLDER-COVERS 前端）。真实本地服务 + 合成项目；
// 后端字段（videoCount / covers）还没实现前，用拦截真实列表响应再补字段的方式替身；字段缺失时验证回退原样式。
// 覆盖：0 / 1 / 2 / 3 / >3 封面，有视频无封面，封面加载失败，旧后端无字段，有子文件夹时不显示大空态，筛选无结果仍提示。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { selectProjectInBar } from './helpers/path-bar.mjs';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'project-videos-folder-covers-')));
const ffmpeg = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
const clipFile = path.join(temp, '合成.mp4');
assert.equal(spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=96x64:r=8:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', clipFile]).status, 0);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkqPpfDwAE/wH+nEwxYgAAAABJRU5ErkJggg==', 'base64');
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const errors = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production', MEDIA_CONTAINER: '0', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal_item'), CODEX_HOME: path.join(temp, 'codex'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_CODEX_AUTOCONNECT: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body, method) {
  const binary = Buffer.isBuffer(body);
  const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': binary ? 'application/octet-stream' : 'application/json' }, body: binary ? body : body ? JSON.stringify(body) : undefined });
  const data = await response.json(); if (!response.ok) throw Object.assign(Error(data.error || response.status), { data }); return data;
}
async function check(name, fn) { await fn(); console.log('PASS ' + name); }
let projectId; const pv = suffix => `/project-videos/projects/${encodeURIComponent(projectId)}${suffix}`;
const work = () => page.getByRole('region', { name: '项目生成视频' });
const folderCard = name => work().locator('.pv-folder-card').filter({ has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) });
const shot = async name => { const dir = process.env.CREATIVE_TEST_EVIDENCE; if (!dir) return; await fs.mkdir(dir, { recursive: true }); await page.screenshot({ path: path.join(dir, name + '.png') }); };
// 替身：每个文件夹按名字补字段；patch=null 表示后端不返回这两个字段（旧后端）
let patch = null;
const covers = (n, broken = false) => Array.from({ length: n }, (_, i) => ({ videoId: `v${i}`, thumbnailUrl: broken && i === 0 ? '/api/media/broken/thumb' : `/api/media/fake-${i}/thumb` }));

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const s = await fetch(origin + '/api/session'); cookie = s.headers.get('set-cookie').split(';')[0]; token = (await s.json()).token;
  projectId = (await api('/projects', { name: '文件夹封面' })).id;
  for (const name of ['A', 'B', 'C', 'D', 'E', 'F']) await api(pv('/folders'), { requestId: crypto.randomUUID(), parentId: 'root', name });
  const F = Object.fromEntries((await api(pv('?folderId=all'))).folders.map(f => [f.name, f.id]));
  // A 里放一个真实视频：进入 A 后搜索无结果，用来验证「筛选无结果」提示仍在
  const bytes = await fs.readFile(clipFile), requestId = crypto.randomUUID();
  await api(pv('/imports'), { requestId, folderId: F.A, fileName: '合成.mp4', bytes: bytes.length, prompt: { mode: 'none' } });
  assert.equal((await api(pv(`/imports/${requestId}/content`), bytes, 'PUT')).status, 'ready');

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await context.route(u => { const p = new URL(u).pathname; return p === `/api/project-videos/projects/${projectId}`; }, async route => {
    const response = await route.fetch(); const json = await response.json();
    if (patch) json.folders = json.folders.map(f => patch[f.name] ? { ...f, ...patch[f.name] } : f);
    return route.fulfill({ response, json });
  });
  await context.route(u => /^\/api\/media\/fake-\d\/thumb$/.test(new URL(u).pathname), r => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await context.route(u => new URL(u).pathname === '/api/media/broken/thumb', r => r.fulfill({ status: 404, json: { error: 'missing' } }));
  const open = async () => { await page.goto(origin + '/#/project-videos'); await expect(work()).toBeVisible(); await selectProjectInBar(page, projectId); await expect(folderCard('A')).toBeVisible(); };

  await check('F1 旧后端（无 videoCount/covers）：卡片照旧显示位置和文件夹图标；根目录有子文件夹时不显示「当前目录还没有视频」', async () => {
    patch = null; await page.goto(origin + '/#/project-videos'); await expect(work()).toBeVisible(); await selectProjectInBar(page, projectId);
    await work().getByRole('navigation', { name: /视频文件夹/ }).getByRole('button', { name: '项目根目录', exact: true }).click();
    await expect(folderCard('A')).toBeVisible();
    await expect(folderCard('A')).toContainText('位于项目根目录');
    await expect(folderCard('A').locator('.pv-folder-cover')).toHaveCount(0);
    await expect(work().getByText('当前目录还没有视频')).toHaveCount(0);
    await shot('f1-legacy');
  });
  await check('F2 0/1/2/3/>3 封面与数量：>3 摆 3 张 +N（N=数量−已摆张数）；0 个写「还没有视频」；有视频无封面用普通图标', async () => {
    patch = {
      A: { videoCount: 8, covers: covers(3) }, B: { videoCount: 2, covers: covers(2) }, C: { videoCount: 1, covers: covers(1) },
      D: { videoCount: 0, covers: [] }, E: { videoCount: 4, covers: [] }, F: { videoCount: 3, covers: covers(3) },
    };
    await page.reload(); await work().getByRole('navigation', { name: /视频文件夹/ }).getByRole('button', { name: '项目根目录', exact: true }).click();
    const imgs = name => folderCard(name).locator('img.pv-folder-cover');
    await expect(imgs('A')).toHaveCount(3); await expect(folderCard('A').locator('.pv-folder-more')).toHaveText('+5'); await expect(folderCard('A')).toContainText('8 个视频');
    await expect(imgs('B')).toHaveCount(2); await expect(folderCard('B').locator('.pv-folder-more')).toHaveCount(0);
    await expect(imgs('C')).toHaveCount(1); await expect(folderCard('C')).toContainText('1 个视频');
    await expect(imgs('D')).toHaveCount(0); await expect(folderCard('D')).toContainText('还没有视频'); await expect(folderCard('D').locator('.pv-folder-visual')).toHaveAttribute('data-empty', 'true');
    await expect(imgs('E')).toHaveCount(0); await expect(folderCard('E')).toContainText('4 个视频'); await expect(folderCard('E')).not.toContainText('还没有视频');
    await expect(folderCard('F').locator('.pv-folder-more')).toHaveCount(0);
    await expect(folderCard('A').locator('.pv-folder-count')).toHaveAttribute('title', '含子文件夹里的视频');
    await expect(work().getByText('当前目录还没有视频')).toHaveCount(0);
    await shot('f2-covers');
  });
  await check('F3 封面加载失败：只隐藏那一张，数量和 +N 不变，不把文件夹当空', async () => {
    patch = { A: { videoCount: 5, covers: covers(3, true) } };
    await page.reload(); await work().getByRole('navigation', { name: /视频文件夹/ }).getByRole('button', { name: '项目根目录', exact: true }).click();
    await expect(folderCard('A').locator('img.pv-folder-cover')).toHaveCount(2);
    await expect(folderCard('A').locator('.pv-folder-more')).toHaveText('+2');
    await expect(folderCard('A')).toContainText('5 个视频');
  });
  await check('F4 进入有视频的文件夹后搜索无结果：仍提示「没有符合筛选条件的视频」', async () => {
    patch = null; await page.reload();
    await work().getByRole('navigation', { name: /视频文件夹/ }).getByRole('button', { name: '项目根目录', exact: true }).click();
    await folderCard('A').click();
    await work().getByRole('searchbox', { name: '搜索视频' }).fill('不存在的名字');
    await expect(work().getByText('没有符合筛选条件的视频')).toBeVisible();
  });
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  if (!passed) console.log(logs.slice(-2000));
  await browser?.close(); child.kill('SIGTERM');
  let t; const out = await Promise.race([exited, new Promise(r => t = setTimeout(() => r('timeout'), 15000))]); clearTimeout(t);
  if (out === 'timeout') console.error(`UNKNOWN: 测试服务 pid ${child.pid} 15 秒内没有正常退出，已保留现场 ${temp}`);
  else await fs.rm(temp, { recursive: true, force: true });
}
