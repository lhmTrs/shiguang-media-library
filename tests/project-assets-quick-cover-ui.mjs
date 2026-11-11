// 项目资产人物卡片的快捷操作：复制默认图（整张原图）、换默认图（跟着换默认造型）、调整头像，
// 点完成就保存并可撤销；详情里参考图悬停「设为代表图」；有未保存修改时不越权保存。
// 独立可写实例：数据目录与合成图片都在临时目录，测试结束后删除。不触碰真实素材库。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-quick-cover-')), images = path.join(temp, '合成照片'); await fs.mkdir(images);
const ffmpeg = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
for (const [name, color] of [['泳衣正面.png', 'red'], ['泳衣侧面.png', 'blue'], ['日常.png', 'green']]) {
  const run = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=300x400`, '-frames:v', '1', path.join(images, name)]);
  assert.equal(run.status, 0, run.stderr?.toString());
}
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const checks = [], errors = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal_item'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', SHIGUANG_AUDIO_ANALYSIS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body, method) { const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json(); assert.ok(response.ok, p + ' ' + JSON.stringify(data)); return data; }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const work = () => page.getByRole('region', { name: '项目资产库' });
const wrap = name => work().locator('.ca-card-wrap').filter({ has: page.locator('strong', { hasText: new RegExp('^' + name + '$') }) });
const undoToast = () => page.locator('.ca-undo-toast');
const asset = id => api('/project-assets/assets/' + id);
let puts = 0;
const shot = async name => { if (process.env.QUICK_COVER_SHOTS) await page.screenshot({ path: path.join(process.env.QUICK_COVER_SHOTS, name + '.png') }); };

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  const project = await api('/projects', { name: '快捷封面短片' });
  await api('/roots', { path: images, kind: 'photo' }); await expect.poll(async () => (await api('/jobs')).jobs.every(j => j.status !== 'running'), { timeout: 20000 }).toBe(true);
  const listed = await api('/assets?kind=photo'), media = Object.fromEntries((listed.assets ?? listed.items).map(m => [m.name, m]));
  let hero = await api('/project-assets/assets', { project_id: project.id, kind: 'character', name: '阿青' });
  const swim = crypto.randomUUID(), daily = crypto.randomUUID(), A = crypto.randomUUID(), B = crypto.randomUUID(), C = crypto.randomUUID();
  const bind = (id, look, file) => ({ id, look_id: look, media_asset_id: media[file].id, reference_type: '人物身份', purpose: '', locks: '', ignores: '', confirmed: true, archived_at: null, crop: { x: 50, y: 50, zoom: 1 }, last_known_name: file });
  hero = await api('/project-assets/assets/' + hero.id, { asset: { ...hero, default_look_id: swim,
    looks: [{ id: swim, name: '泳衣', description: '', tags: [], default_image_id: A, archived_at: null }, { id: daily, name: '日常', description: '', tags: [], default_image_id: C, archived_at: null }],
    images: [bind(A, swim, '泳衣正面.png'), bind(B, swim, '泳衣侧面.png'), bind(C, daily, '日常.png')] }, expected_revision: hero.revision }, 'PUT');
  await api('/project-assets/assets', { project_id: project.id, kind: 'character', name: '苏禾' });

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] }); await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.method() === 'PUT' && /\/api\/project-assets\/assets\/[^/]+$/.test(new URL(r.url()).pathname)) puts++; });
  await page.goto(origin + '/#/project-assets'); await expect(work()).toBeVisible(); await page.getByLabel('资产所属项目').selectOption(project.id);
  await expect(wrap('阿青')).toBeVisible(); await expect(wrap('苏禾')).toBeVisible();

  await check('悬停卡片出现「复制」，复制的是整张原图（PNG，原尺寸）；没有默认图的不显示复制', async () => {
    await wrap('阿青').hover(); await shot('1-hover'); await wrap('阿青').getByRole('button', { name: '复制阿青的默认图' }).click();
    await expect(page.getByText('已复制「阿青」的默认图（整张原图），到画布平台按 ⌘V 粘贴').first()).toBeVisible();
    const copied = await page.evaluate(async () => { const [item] = await navigator.clipboard.read(); const blob = await item.getType('image/png'); const bmp = await createImageBitmap(blob); return { types: item.types, w: bmp.width, h: bmp.height }; });
    assert.deepEqual(copied, { types: ['image/png'], w: 300, h: 400 });
    await expect(wrap('苏禾').getByRole('button', { name: /复制/ })).toHaveCount(0);
  });

  await check('右键「换默认图」：选另一个造型的图，马上保存，默认造型跟着换；撤销后恢复', async () => {
    await wrap('阿青').click({ button: 'right' });
    const menu = page.getByRole('menu', { name: '阿青的操作' }); await expect(menu.getByRole('menuitem')).toHaveText(['复制默认图', '换默认图…', '调整头像…', '打开详情']);
    await menu.getByRole('menuitem', { name: '换默认图…' }).click();
    const panel = page.getByRole('dialog', { name: '换阿青的默认图' });
    await expect(panel.getByRole('region', { name: '造型 · 泳衣' }).getByRole('button')).toHaveCount(2);
    await expect(panel.getByRole('button', { name: '当前默认图：泳衣正面.png' })).toBeDisabled(); await shot('2-pick');
    await panel.getByRole('button', { name: '设为默认：日常.png' }).click();
    await expect(undoToast()).toContainText('已把「阿青」的默认图换成「日常.png」，默认造型也换成了「日常」'); await shot('2b-undo');
    let a = await asset(hero.id); assert.equal(a.default_look_id, daily); assert.equal(a.looks.find(l => l.id === daily).default_image_id, C);
    await undoToast().getByRole('button', { name: '撤销' }).click();
    await expect.poll(async () => (await asset(hero.id)).default_look_id).toBe(swim);
    a = await asset(hero.id); assert.equal(a.looks.find(l => l.id === swim).default_image_id, A); assert.equal(a.looks.find(l => l.id === daily).default_image_id, C);
  });

  await check('⋯「调整头像」：在卡片旁直接裁，点完成就保存；撤销恢复原裁切', async () => {
    await wrap('阿青').hover(); await wrap('阿青').getByRole('button', { name: '阿青的更多操作' }).click();
    await page.getByRole('menu', { name: '阿青的操作' }).getByRole('menuitem', { name: '调整头像…' }).click();
    const panel = page.getByRole('dialog', { name: '调整阿青的头像' }); await expect(panel).toContainText('列表里会这样显示');
    const frame = panel.locator('.ca-quick-cropbox [tabindex]').first(); await frame.focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowUp'); await shot('3-crop');
    await panel.getByRole('button', { name: '完成' }).click(); await expect(undoToast()).toContainText('已更新「阿青」的头像');
    const crop = (await asset(hero.id)).images.find(b => b.id === A).crop; assert.notDeepEqual(crop, { x: 50, y: 50, zoom: 1 }, 'crop saved');
    await undoToast().getByRole('button', { name: '撤销' }).click();
    await expect.poll(async () => (await asset(hero.id)).images.find(b => b.id === A).crop).toEqual({ x: 50, y: 50, zoom: 1 });
  });

  await check('撤销只还原本次改过的字段：别处随后改的其他设置保留；同一字段被别处改过则不写入（POLISH 独验反例）', async () => {
    const other = async fn => { const a = await asset(hero.id); fn(a); return api('/project-assets/assets/' + hero.id, { asset: a, expected_revision: a.revision }, 'PUT'); };
    const cropOnCard = async () => {
      await wrap('阿青').click({ button: 'right' }); await page.getByRole('menuitem', { name: '调整头像…' }).click();
      const panel = page.getByRole('dialog', { name: '调整阿青的头像' }); await panel.locator('.ca-quick-cropbox [tabindex]').first().focus();
      for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowUp');
      await panel.getByRole('button', { name: '完成' }).click(); await expect(undoToast()).toContainText('已更新「阿青」的头像');
    };
    // 1. Another window then changes different display fields: undo reverts A's crop only.
    await cropOnCard(); const mine = (await asset(hero.id)).images.find(b => b.id === A).crop;
    await other(a => { a.default_look_id = daily; a.images.find(b => b.id === C).crop = { x: 31, y: 73, zoom: 1.8 }; });
    await undoToast().getByRole('button', { name: '撤销' }).click();
    await expect.poll(async () => (await asset(hero.id)).images.find(b => b.id === A).crop).toEqual({ x: 50, y: 50, zoom: 1 });
    let a = await asset(hero.id);
    assert.equal(a.default_look_id, daily, 'the other window\'s default look stays'); assert.deepEqual(a.images.find(b => b.id === C).crop, { x: 31, y: 73, zoom: 1.8 }, 'the other crop stays');
    assert.notDeepEqual(mine, { x: 50, y: 50, zoom: 1 });
    // 2. Another window changes the same field: undo writes nothing and says so.
    // (The card now shows 日常's image C — the default look the other window chose.)
    await cropOnCard(); assert.notDeepEqual((await asset(hero.id)).images.find(b => b.id === C).crop, { x: 31, y: 73, zoom: 1.8 });
    await other(a => { a.images.find(b => b.id === C).crop = { x: 20, y: 20, zoom: 1.5 }; });
    const before = puts, revision = (await asset(hero.id)).revision;
    await undoToast().getByRole('button', { name: '撤销' }).click();
    await expect(page.getByText('这些显示设置在别处又改过了，没有撤销，保留了现在的设置').first()).toBeVisible();
    a = await asset(hero.id); assert.deepEqual(a.images.find(b => b.id === C).crop, { x: 20, y: 20, zoom: 1.5 }); assert.equal(a.revision, revision); assert.equal(puts, before, 'no write from the page');
    // Reset for the next check.
    await other(a => { a.default_look_id = swim; a.images.find(b => b.id === A).crop = { x: 50, y: 50, zoom: 1 }; a.images.find(b => b.id === C).crop = { x: 50, y: 50, zoom: 1 }; });
  });

  await check('详情里参考图悬停「设为代表图」马上生效；有未保存修改时卡片快捷操作不保存', async () => {
    await work().locator('.ca-card').filter({ hasText: '阿青' }).first().click();
    const tile = work().locator('.ca-tile').filter({ hasText: '泳衣侧面.png' }); await tile.hover();
    await tile.getByRole('button', { name: '设为代表图：泳衣侧面.png' }).click(); await expect(undoToast()).toContainText('已把「泳衣侧面.png」设为代表图');
    assert.equal((await asset(hero.id)).looks.find(l => l.id === swim).default_image_id, B);
    await expect(work().getByRole('button', { name: '保存资料' })).toBeDisabled();
    // Unsaved edits in the open detail: quick actions on that card refuse instead of saving them along.
    await work().getByLabel('基础信息', { exact: true }).fill('还没保存的描述');
    const before = puts;
    await wrap('阿青').click({ button: 'right' }); await page.getByRole('menuitem', { name: '换默认图…' }).click();
    await page.getByRole('dialog', { name: '换阿青的默认图' }).getByRole('button', { name: '设为默认：日常.png' }).click();
    await expect(page.getByText('这个人物有未保存的修改，请先保存或放弃修改，再改默认图或头像').first()).toBeVisible();
    assert.equal(puts, before, 'nothing saved'); assert.equal((await asset(hero.id)).default_look_id, swim);
  });

  assert.deepEqual(errors, [], '页面不应出现脚本错误');
  passed = true;
} finally {
  if (!passed) { console.error(logs.slice(-3000)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'creative-quick-cover-failure.png') }).catch(() => {}); }
  await browser?.close(); child.kill('SIGTERM'); await exited; await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
