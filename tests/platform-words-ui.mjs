// 界面上跟系统有关的字（Windows 原生运行设计 v1 阶段 2）。真实本地服务 + 合成项目；不接入真实素材库。
// - Mac 组：服务端不带 platform（今天的后台）、浏览器是 Mac：关键文字和原来逐字相同，右键收纳入口照旧显示。
// - win32 组：用 mock 让 /api/session 说 platform=win32、文件任务状态说 supported=false，浏览器伪装成 Windows：
//   换成「回收站 / 系统组件 / 在文件夹中显示 / Ctrl+C」，右键收纳安装区和空白页教程不显示。
// 这只是模拟；真 Windows 电脑上的样子还要阶段 3 真机看。需要先 npm run build。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { selectProjectInBar } from './helpers/path-bar.mjs';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-platform-words-')), images = path.join(temp, '合成照片'); await fs.mkdir(images);
const ffmpeg = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
for (const [i, name] of ['甲', '乙'].entries()) {
  const run = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x${['aa5533', '3355aa'][i]}:s=300x400`, '-frames:v', '1', path.join(images, name + '.png')]);
  assert.equal(run.status, 0, run.stderr?.toString());
}
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, cookie, token, passed = false; const checks = [], errors = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal_item'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body, method) { const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json(); assert.ok(response.ok, p + ' ' + JSON.stringify(data)); return data; }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
/** platform：undefined = 服务端不带这个字段（今天的后台），否则写进 /api/session。trashAvailable 一律模拟成 true，好看到「…组件可用」那句。 */
async function openPage({ platform, windowsBrowser }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...(windowsBrowser ? { userAgent: WINDOWS_UA } : {}) });
  await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  if (windowsBrowser) await context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Win32' }));
  await context.route(url => url.pathname === '/api/session', async route => {
    const response = await route.fetch(), body = await response.json();
    await route.fulfill({ response, json: { ...body, trashAvailable: true, ...(platform === undefined ? {} : { platform }) } });
  });
  // Windows 上的后台本来就回 supported=false（file-intake/native.mjs 只认 darwin）；这里在 Mac 上跑，只好模拟。
  if (platform && platform !== 'darwin') await context.route(url => url.pathname === '/api/file-intake/status', async route => {
    const response = await route.fetch(), body = await response.json();
    await route.fulfill({ response, json: { ...body, supported: false, installed: false, upgradeNeeded: false } });
  });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  return { context, page };
}
const settingsTrash = page => page.locator('.settings-list dt').filter({ hasText: /^(废纸篓|回收站)$/ });
async function openSettings(page) { await page.getByRole('button', { name: '设置与缓存' }).click(); await expect(page.locator('.settings-list')).toBeVisible(); }
async function closeSettings(page) { await page.locator('.modal-head').getByRole('button', { name: '关闭窗口' }).click(); await expect(page.locator('.settings-list')).toHaveCount(0); }
const drawer = page => page.getByRole('dialog', { name: '文件任务' });
async function openTasks(page) { await page.getByRole('button', { name: /^文件任务/ }).click(); await expect(drawer(page)).toBeVisible(); await expect(drawer(page).getByRole('heading', { name: '暂无文件任务' })).toBeVisible(); }
const work = page => page.getByRole('region', { name: '项目资产库' });
const card = (page, name) => work(page).locator('.ca-card-wrap').filter({ has: page.locator('strong', { hasText: new RegExp('^' + name + '$') }) }).locator('.ca-card');
async function pickTwo(page, project, modifier) {
  await page.goto(origin + '/#/project-assets'); await expect(work(page)).toBeVisible(); await selectProjectInBar(page, project.id);
  await card(page, '甲').click(); await card(page, '乙').click({ modifiers: [modifier] });
  const bar = work(page).getByRole('toolbar', { name: '已选人物操作' }); await expect(bar).toContainText('已选 2 个人物'); return bar;
}

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  const project = await api('/projects', { name: '系统用词项目' });
  // 两个带默认图的人物（没有默认图的人物不能多选）：图来自合成照片目录
  await api('/roots', { path: images, kind: 'photo' }); await expect.poll(async () => (await api('/jobs')).jobs.every(j => j.status !== 'running'), { timeout: 20000 }).toBe(true);
  const listed = await api('/assets?kind=photo'), media = Object.fromEntries((listed.assets ?? listed.items).map(m => [m.name, m]));
  for (const name of ['甲', '乙']) {
    const a = await api('/project-assets/assets', { project_id: project.id, kind: 'character', name }), look = crypto.randomUUID(), img = crypto.randomUUID();
    await api('/project-assets/assets/' + a.id, { asset: { ...a, default_look_id: look, looks: [{ id: look, name: '日常', description: '', tags: [], default_image_id: img, archived_at: null }], images: [{ id: img, look_id: look, media_asset_id: media[name + '.png'].id, reference_type: '人物身份', purpose: '', locks: '', ignores: '', confirmed: true, archived_at: null, crop: { x: 50, y: 50, zoom: 1 }, last_known_name: name + '.png' }] }, expected_revision: a.revision }, 'PUT');
  }
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });

  // ---- Mac：服务端不带 platform 字段，按 darwin；文字逐字是原来的 ----
  {
    const { context, page } = await openPage({ platform: undefined, windowsBrowser: false });
    await page.goto(origin + '/#/materials');
    await check('Mac（无 platform 字段）：设置里写「废纸篓 / Mac 原生组件可用」', async () => {
      await openSettings(page); await expect(settingsTrash(page)).toHaveText('废纸篓');
      await expect(settingsTrash(page).locator('xpath=following-sibling::dd[1]')).toHaveText('Mac 原生组件可用'); await closeSettings(page);
    });
    await check('Mac：文件任务空白页照旧教「在访达选择素材，右键…」，访达右键入口照旧显示', async () => {
      await openTasks(page);
      await expect(drawer(page).locator('.fi-empty p')).toHaveText('在访达选择素材，右键“收纳素材到拾光”，确认目标后在这里查看。');
      await expect(drawer(page).getByRole('heading', { name: '访达右键入口' })).toBeVisible();
      await drawer(page).getByRole('button', { name: '关闭文件任务', exact: true }).click();
    });
    await check('粘贴路径：只去外侧空白和成对引号，引号里的首尾空格保留，不会选到并排的另一个目录；拦下请求不写库', async () => {
      // 并排的合成目录：名字只差首尾一个空格，在 macOS / POSIX 上是三个不同的目录
      const plain = path.join(temp, '所选目录'), trailing = plain + ' ', leading = path.join(temp, ' 所选目录');
      for (const dir of [plain, trailing, leading]) await fs.mkdir(dir);
      const real = await Promise.all([plain, trailing, leading].map(d => fs.realpath(d))); assert.equal(new Set(real).size, 3);
      const sent = [];
      await page.route(url => url.pathname === '/api/roots', route => { if (route.request().method() !== 'POST') return route.fallback(); sent.push(route.request().postDataJSON().path); return route.fulfill({ status: 400, json: { error: '测试拦截，未登记' } }); });
      await page.getByRole('button', { name: '管理素材目录' }).click();
      const input = page.getByRole('textbox', { name: '素材文件夹绝对路径' }), add = page.getByRole('button', { name: '添加路径' });
      for (const [typed, expected] of [['"' + trailing + '"', trailing], ['  "' + leading + '"  ', leading], ["'" + trailing + "'", trailing], ['  ' + plain + '  ', plain], ['"' + plain + '"', plain]]) {
        await input.fill(typed); await add.click(); await expect.poll(() => sent.length).toBeGreaterThan(0);
        assert.equal(sent.pop(), expected, '输入 ' + JSON.stringify(typed));
      }
      for (const blank of ['""', '"   "', '   ']) { await input.fill(blank); await expect(add).toBeDisabled(); }
      assert.equal((await api('/roots')).length, 1, '只有开头登记的合成照片目录');
      await page.unroute(url => url.pathname === '/api/roots');
      await page.locator('.modal-head').getByRole('button', { name: '关闭窗口' }).click();
    });
    await check('Mac：素材列表的定位按钮悬停写「在访达中显示」', async () => {
      await page.goto(origin + '/#/photos'); await expect(page.getByRole('button', { name: '定位素材：甲.png' })).toHaveAttribute('title', '在访达中显示');
    });
    await check('Mac：多选人物的工具条写「⌘C 也可以复制」和「在访达中显示」', async () => {
      const bar = await pickTwo(page, project, 'Meta');
      await expect(bar).toContainText('每个复制一张默认图（原图文件）· ⌘C 也可以复制');
      await expect(bar.getByRole('button', { name: '在访达中显示', exact: true })).toBeVisible();
    });
    await context.close();
  }

  // ---- 明写 darwin 也一样（Codex 加上字段以后的样子）----
  {
    const { context, page } = await openPage({ platform: 'darwin', windowsBrowser: false });
    await page.goto(origin + '/#/materials');
    await check('Mac（platform=darwin）：设置里同样是「废纸篓 / Mac 原生组件可用」，右键入口照旧显示', async () => {
      await openSettings(page); await expect(settingsTrash(page)).toHaveText('废纸篓');
      await expect(settingsTrash(page).locator('xpath=following-sibling::dd[1]')).toHaveText('Mac 原生组件可用'); await closeSettings(page);
      await openTasks(page); await expect(drawer(page).getByRole('heading', { name: '访达右键入口' })).toBeVisible();
    });
    await context.close();
  }

  // ---- win32（mock）：服务端说 win32、浏览器是 Windows ----
  {
    const { context, page } = await openPage({ platform: 'win32', windowsBrowser: true });
    await page.goto(origin + '/#/materials');
    await check('win32：设置里写「回收站 / 系统组件可用」，页面上不出现「废纸篓」「Mac 原生组件」', async () => {
      await openSettings(page); await expect(settingsTrash(page)).toHaveText('回收站');
      await expect(settingsTrash(page).locator('xpath=following-sibling::dd[1]')).toHaveText('系统组件可用');
      const text = await page.locator('.settings-list').innerText(); assert.ok(!/废纸篓|Mac 原生组件/.test(text), text); await closeSettings(page);
    });
    await check('win32：文件任务里没有访达右键入口，空白页不教右键收纳', async () => {
      await openTasks(page);
      await expect(drawer(page).locator('.fi-install')).toHaveCount(0);
      await expect(drawer(page).locator('.fi-empty p')).toHaveCount(0);
      const text = await drawer(page).innerText(); assert.ok(!/访达|右键/.test(text), text);
      await drawer(page).getByRole('button', { name: '关闭文件任务', exact: true }).click();
    });
    await check('win32：素材列表的定位按钮悬停写「在文件夹中显示」', async () => {
      await page.goto(origin + '/#/photos'); await expect(page.getByRole('button', { name: '定位素材：甲.png' })).toHaveAttribute('title', '在文件夹中显示');
    });
    // 这台测试机是 Mac：Chromium 在 macOS 上把 Ctrl+单击当成右键，所以这里仍用 Meta 单击多选（代码认 metaKey），只核对提示文字。
    await check('win32：多选人物的工具条写「Ctrl+C 也可以复制」和「在文件夹中显示」，没有 ⌘ 和「访达」', async () => {
      const bar = await pickTwo(page, project, 'Meta');
      await expect(bar).toContainText('每个复制一张默认图（原图文件）· Ctrl+C 也可以复制');
      await expect(bar.getByRole('button', { name: '在文件夹中显示', exact: true })).toBeVisible();
      const text = await bar.innerText(); assert.ok(!/⌘|访达/.test(text), text);
    });
    await context.close();
  }

  assert.deepEqual(errors, []);
  passed = true;
} finally {
  await browser?.close(); child.kill('SIGTERM'); await exited;
  if (!passed) console.error(logs.slice(-4000));
  await fs.rm(temp, { recursive: true, force: true });
}
console.log(`平台用词界面检查通过：${checks.length} 项`);
