// 项目资产图片多选复制的前后端联调：真实服务 + 真实图片桌面接口（剪贴板 / 访达），
// 只把最底层的本机桌面调用换成替身（tests/helpers/asset-desktop-native-stub.mjs），
// 核对界面发出的请求经后端校验后，真正交给系统的是哪些原图文件。
// 合成图片、临时数据目录；不触碰真实剪贴板、访达和素材库。需要先 npm run build。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'creative-multicopy-real-')));
const images = path.join(temp, '合成照片'), daily = path.join(images, '日常造型'); await fs.mkdir(daily, { recursive: true });
const ffmpeg = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
for (const [file, color] of [[path.join(images, '泳衣正面.png'), 'red'], [path.join(images, '泳衣侧面.png'), 'blue'], [path.join(daily, '日常.png'), 'green']]) {
  const run = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=300x400`, '-frames:v', '1', file]);
  assert.equal(run.status, 0, run.stderr?.toString());
}
const nativeLog = path.join(temp, 'native.jsonl'); await fs.writeFile(nativeLog, '');
const stub = path.join(root, 'tests/helpers/asset-desktop-native-stub.mjs');
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false, child, exited; const checks = [], errors = [];
function start(extra = {}) {
  child = spawn(process.execPath, ['--import', stub, 'server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal_item'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', SHIGUANG_AUDIO_ANALYSIS: '0', ASSET_NATIVE_LOG: nativeLog, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); exited = new Promise(r => child.once('exit', r));
}
async function session() { await expect.poll(async () => { try { return (await fetch(origin + '/api/session')).ok; } catch { return false; } }, { timeout: 25000 }).toBe(true); const r = await fetch(origin + '/api/session'); cookie = r.headers.get('set-cookie').split(';')[0]; token = (await r.json()).token; }
async function api(p, body, method) { const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json(); assert.ok(response.ok, p + ' ' + JSON.stringify(data)); return data; }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const native = async op => (await fs.readFile(nativeLog, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => !op || e.op === op);
const work = () => page.getByRole('region', { name: '项目资产库' });
const wrap = name => work().locator('.ca-card-wrap').filter({ has: page.locator('strong', { hasText: new RegExp('^' + name + '$') }) });
const status = () => page.locator('.ca-desktop-status');
const names = paths => paths.map(p => path.relative(images, p));

try {
  start(); await session();
  const project = await api('/projects', { name: '多选复制联调' });
  await api('/roots', { path: images, kind: 'photo' }); await expect.poll(async () => (await api('/jobs')).jobs.every(j => j.status !== 'running'), { timeout: 20000 }).toBe(true);
  const listed = await api('/assets?kind=photo'), media = Object.fromEntries((listed.assets ?? listed.items).map(m => [m.name, m]));
  assert.ok(media['泳衣正面.png'] && media['泳衣侧面.png'] && media['日常.png'], 'synthetic photos indexed');
  const bind = (id, look, file) => ({ id, look_id: look, media_asset_id: media[file].id, reference_type: '人物身份', purpose: '', locks: '', ignores: '', confirmed: true, archived_at: null, crop: { x: 50, y: 50, zoom: 1 }, last_known_name: file });
  const make = async (name, files) => {
    let a = await api('/project-assets/assets', { project_id: project.id, kind: 'character', name });
    const swim = crypto.randomUUID(), day = crypto.randomUUID(), ids = files.map(() => crypto.randomUUID());
    a = await api('/project-assets/assets/' + a.id, { asset: { ...a, default_look_id: swim,
      looks: [{ id: swim, name: '泳衣', description: '', tags: [], default_image_id: ids[0], archived_at: null }, { id: day, name: '日常', description: '', tags: [], default_image_id: ids.at(-1), archived_at: null }],
      images: files.map((f, i) => bind(ids[i], i === files.length - 1 ? day : swim, f)) }, expected_revision: a.revision }, 'PUT');
    return { a, ids };
  };
  const hero = await make('阿青', ['泳衣正面.png', '泳衣侧面.png', '日常.png']);
  const second = await make('小满', ['泳衣侧面.png', '日常.png']);

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0')); await context.addInitScript(() => { window.__clipWrites = 0; const c = navigator.clipboard; if (c?.write) { const w = c.write.bind(c); c.write = (...a) => { window.__clipWrites++; return w(...a); }; } });
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  const open = async () => { await page.goto(origin + '/#/project-assets'); await page.reload(); /* 同一地址只改 hash 不会重载，桌面能力也不会重新读取 */ await expect(work()).toBeVisible(); await page.getByLabel('资产所属项目').selectOption(project.id); await expect(wrap('阿青')).toBeVisible(); };
  await open();

  await check('人物列表多选复制：后端核对后把每人默认图的原文件交给系统剪贴板', async () => {
    await wrap('阿青').hover(); await wrap('阿青').getByRole('checkbox', { name: '选择阿青' }).click();
    await wrap('小满').locator('.ca-card').click();
    const bar = work().getByRole('toolbar', { name: '已选人物操作' }); await expect(bar).toContainText('已选 2 个人物');
    await expect(bar.getByRole('button', { name: '复制' })).toBeEnabled();
    await bar.getByRole('button', { name: '复制' }).click();
    await expect(status()).toContainText('已复制 2 张原图文件，到画布平台按 ⌘V 粘贴');
    const copy = (await native('copy')).at(-1); assert.deepEqual(names(copy.paths), ['泳衣正面.png', '泳衣侧面.png']); assert.equal(copy.expectedChangeCount, 7);
    await page.keyboard.press('Escape'); await status().getByRole('button', { name: /收起|关闭/ }).click().catch(() => {});
  });

  await check('卡片上的单张「复制」走同一个原图文件接口', async () => {
    const before = (await native('copy')).length;
    await wrap('小满').hover(); await wrap('小满').getByRole('button', { name: '复制小满的默认图' }).click();
    await expect(status()).toContainText('已复制 1 张原图文件');
    const copies = await native('copy'); assert.equal(copies.length, before + 1); assert.deepEqual(names(copies.at(-1).paths), ['泳衣侧面.png']);
  });

  await check('选中后绑定被别处改动：后端跳过这张并说明原因，界面如实显示部分完成', async () => {
    await wrap('阿青').locator('.ca-card').click({ modifiers: ['Meta'] }); await wrap('小满').locator('.ca-card').click();
    const fresh = await api('/project-assets/assets/' + second.a.id);
    await api('/project-assets/assets/' + second.a.id, { asset: { ...fresh, images: fresh.images.map(b => b.id === second.ids[0] ? { ...b, purpose: '别处改了用途' } : b) }, expected_revision: fresh.revision }, 'PUT');
    await work().getByRole('toolbar', { name: '已选人物操作' }).getByRole('button', { name: '复制' }).click();
    await expect(status()).toContainText('已复制 1 张原图文件'); await expect(status()).toContainText('跳过 1 张'); await expect(status()).toContainText('图片绑定已变化');
    assert.deepEqual(names((await native('copy')).at(-1).paths), ['泳衣正面.png']);
    await page.keyboard.press('Escape');
  });

  await check('详情参考图跨造型多选：复制 3 个原文件；分在 2 个文件夹时先确认再在访达中显示', async () => {
    await open();
    await wrap('阿青').locator('.ca-card').click(); await expect(work().getByLabel('基础信息', { exact: true })).toBeVisible();
    const tile = name => work().locator('.ca-tile').filter({ hasText: name });
    await tile('泳衣侧面.png').locator('.ca-tile-open').click({ modifiers: ['Meta'] });
    await tile('泳衣正面.png').locator('.ca-tile-open').click();
    await work().getByRole('button', { name: /日常/ }).first().click();
    await tile('日常.png').locator('.ca-tile-open').click();
    const bar = work().getByRole('toolbar', { name: '已选参考图操作' }); await expect(bar).toContainText('已选 3 张');
    await bar.getByRole('button', { name: '复制' }).click(); await expect(status()).toContainText('已复制 3 张原图文件');
    assert.deepEqual(new Set(names((await native('copy')).at(-1).paths)), new Set(['泳衣正面.png', '泳衣侧面.png', '日常造型/日常.png']));
    const reveals = (await native('reveal')).length;
    await bar.getByRole('button', { name: '在访达中显示' }).click();
    const ask = page.getByRole('dialog', { name: '在访达中显示所选图片' }); await expect(ask).toContainText('会打开 2 个访达窗口');
    await expect(ask).toContainText('合成照片'); await expect(ask).toContainText('日常造型');
    assert.equal((await native('reveal')).length, reveals, 'nothing revealed before confirming');
    await ask.getByRole('button', { name: '打开' }).click(); await expect(status()).toContainText('已请求在访达中显示 3 张');
    assert.deepEqual(new Set(names((await native('reveal')).at(-1).paths)), new Set(['泳衣正面.png', '泳衣侧面.png', '日常造型/日常.png']));
    await page.keyboard.press('Escape');
  });

  await check('关闭本机桌面能力后：多选按钮停用并显示后端给的原因；人物单张两个入口都说明原因，不调用原生、不写浏览器剪贴板、不显示成功', async () => {
    child.kill('SIGTERM'); await exited; start({ MEDIA_DISABLE_DESKTOP_NATIVE: '1' }); await session();
    await context.clearCookies(); await open();
    await wrap('阿青').hover(); await wrap('阿青').getByRole('checkbox', { name: '选择阿青' }).click();
    const bar = work().getByRole('toolbar', { name: '已选人物操作' });
    await expect(bar.getByRole('button', { name: '复制' })).toBeDisabled(); await expect(bar).toContainText('本机桌面连接不可用');
    await page.keyboard.press('Escape');
    const n = (await native('copy')).length;
    await wrap('阿青').hover(); await wrap('阿青').getByRole('button', { name: '复制阿青的默认图' }).click();
    await expect(page.getByText('没有复制「阿青」的默认图：本机桌面连接不可用').first()).toBeVisible();
    await wrap('阿青').click({ button: 'right' }); await page.getByRole('menu', { name: '阿青的操作' }).getByRole('menuitem', { name: '复制默认图' }).click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByText(/已复制「阿青」|已复制 \d+ 张/)).toHaveCount(0);
    assert.equal((await native('copy')).length, n, 'disabled native never copies files'); assert.equal(await page.evaluate(() => window.__clipWrites), 0, 'no browser clipboard.write');
  });

  assert.deepEqual(errors, [], '页面不应出现脚本错误');
  passed = true;
} finally {
  if (!passed) { console.error(logs.slice(-3000)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'creative-multicopy-real-failure.png') }).catch(() => {}); }
  await browser?.close(); child?.kill('SIGTERM'); await exited; await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
