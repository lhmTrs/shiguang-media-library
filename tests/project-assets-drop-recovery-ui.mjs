// 拖入图片在“写入已成功、浏览器没收到回应”时的恢复：不重新上传、不重复绑定、代表图不变。
// 独立可写实例：MEDIA_DATA_DIR 与 MEDIA_PERSONAL_ITEM_DIR 都在临时目录，测试结束后删除。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-drop-recovery-')), images = path.join(temp, '合成照片'); await fs.mkdir(images);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64');
await fs.writeFile(path.join(images, '已有图片.png'), png);
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const checks = [], errors = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal_item'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', SHIGUANG_AUDIO_ANALYSIS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body, method) { const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json(); assert.ok(response.ok, p + ' ' + JSON.stringify(data)); return data; }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const work = () => page.getByRole('region', { name: '项目资产库' }), dialog = () => page.getByRole('dialog');
const card = name => work().locator('.ca-card').filter({ has: page.locator('strong', { hasText: new RegExp('^' + name + '$') }) });
async function dropFiles(target, names) { await target.evaluate(async (node, list) => { const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII='), c => c.charCodeAt(0)); const data = new DataTransfer(); for (const n of list) data.items.add(new File([bytes, new TextEncoder().encode(n)], n, { type: 'image/png' })); for (const type of ['dragenter', 'dragover', 'drop']) node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data })); }, names); }
// 让请求真实到达服务器并完成，只丢掉传回浏览器的回应（第一次命中）。
async function dropResponseOnce(match) { let dropped = false; const handler = async route => { if (dropped || !match(route.request())) return route.fallback(); dropped = true; await route.fetch(); await route.abort('failed'); }; await page.route('**/api/project-assets/**', handler); return () => dropped; }
const count = { start: 0, content: 0, resolve: 0, assetPut: 0, create: 0 };
const live = asset => asset.images.filter(b => !b.archived_at);
try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  const project = await api('/projects', { name: '恢复测试短片' });
  await api('/roots', { path: images, kind: 'photo' }); await expect.poll(async () => (await api('/jobs')).jobs.every(j => j.status !== 'running'), { timeout: 20000 }).toBe(true);
  // 已有人物：一个默认造型 + 一张代表图
  const media = (await api('/assets?kind=photo')).assets ?? (await api('/assets?kind=photo')).items; const existing = media[0];
  let hero = await api('/project-assets/assets', { project_id: project.id, kind: 'character', name: '陈川' });
  const lookId = crypto.randomUUID(), coverId = crypto.randomUUID();
  hero = await api('/project-assets/assets/' + hero.id, { asset: { ...hero, default_look_id: lookId, looks: [{ id: lookId, name: '日常', description: '', tags: [], default_image_id: coverId, archived_at: null }], images: [{ id: coverId, look_id: lookId, media_asset_id: existing.id, reference_type: '人物身份', purpose: '', locks: '', ignores: '', confirmed: false, archived_at: null, crop: { x: 50, y: 50, zoom: 1 }, last_known_name: existing.name }] }, expected_revision: hero.revision }, 'PUT');
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { const u = r.url(); if (!u.includes('/api/project-assets/')) return; if (r.method() === 'POST' && u.endsWith('/image-imports')) count.start++; if (r.method() === 'PUT' && u.includes('/content')) count.content++; if (u.endsWith('/resolve')) count.resolve++; if (r.method() === 'PUT' && /\/assets\/[^/]+$/.test(u)) count.assetPut++; if (r.method() === 'POST' && u.endsWith('/project-assets/assets')) count.create++; });
  await page.goto(origin + '/#/project-assets'); await expect(work()).toBeVisible(); await page.getByLabel('资产所属项目').selectOption(project.id); await expect(card('陈川')).toBeVisible();

  await check('上传成功后丢回应：核对原回执后只绑定一次，不重新上传', async () => {
    const dropped = await dropResponseOnce(r => r.method() === 'PUT' && r.url().includes('/content'));
    await dropFiles(card('陈川'), ['上传丢回应.png']); await expect(dialog()).toContainText('添加到“陈川”'); await dialog().getByRole('button', { name: '添加图片' }).click();
    await expect(dialog().locator('.ca-drop-list li')).toContainText('结果待核对'); assert.ok(dropped()); assert.equal(count.content, 1);
    // 服务器端图片其实已经导入完成，但还没有绑定
    assert.equal(live(await api('/project-assets/assets/' + hero.id)).length, 1);
    await expect(dialog().locator('footer').getByRole('button', { name: '核对结果' })).toBeVisible(); await expect(dialog().getByLabel('放进造型')).toBeDisabled();
    await dialog().locator('footer').getByRole('button', { name: '核对结果' }).click(); await expect(dialog().locator('.ca-drop-list li')).toContainText('已添加');
    assert.equal(count.content, 1, '核对时不应重新上传'); assert.equal(count.resolve, 0);
    const after = await api('/project-assets/assets/' + hero.id); assert.equal(live(after).length, 2); assert.equal(after.looks[0].default_image_id, coverId, '代表图保持不变');
    await dialog().getByRole('button', { name: '完成', exact: true }).click(); await expect(dialog()).toHaveCount(0); await page.unrouteAll({ behavior: 'wait' });
  });

  await check('绑定成功后丢回应：识别原绑定为成功，不重复添加', async () => {
    const before = await api('/project-assets/assets/' + hero.id), content = count.content;
    const dropped = await dropResponseOnce(r => r.method() === 'PUT' && r.url().endsWith('/project-assets/assets/' + hero.id));
    await dropFiles(card('陈川'), ['绑定丢回应.png']); await dialog().getByRole('button', { name: '添加图片' }).click();
    await expect(dialog().locator('.ca-drop-list li')).toContainText('结果待核对'); assert.ok(dropped());
    const saved = await api('/project-assets/assets/' + hero.id); assert.equal(live(saved).length, live(before).length + 1); assert.equal(saved.revision, before.revision + 1);
    await dialog().locator('.ca-drop-list').getByRole('button', { name: '核对结果' }).click(); await expect(dialog().locator('.ca-drop-list li')).toContainText('图片此前已保存，没有重复添加');
    const after = await api('/project-assets/assets/' + hero.id); assert.equal(live(after).length, live(before).length + 1, '同一造型只有一条新绑定'); assert.equal(after.revision, saved.revision, '核对不应再次保存');
    assert.equal(new Set(live(after).map(b => b.media_asset_id)).size, live(after).length); assert.equal(after.looks[0].default_image_id, coverId); assert.equal(count.content, content + 1, '整个过程只上传一次');
    await dialog().getByRole('button', { name: '完成', exact: true }).click(); await page.unrouteAll({ behavior: 'wait' });
  });

  await check('新建资料丢回应：找回刚建立的资料，不重复新建；新人物自动建默认造型', async () => {
    const dropped = await dropResponseOnce(r => r.method() === 'POST' && r.url().endsWith('/project-assets/assets')), created = count.create;
    await dropFiles(work().locator('.ca-gallery'), ['新人物乙.png']); await dialog().getByRole('button', { name: /^新建 1 个人物/ }).click();
    await expect(dialog().locator('.ca-drop-list li')).toContainText('结果待核对'); assert.ok(dropped());
    await dialog().locator('footer').getByRole('button', { name: '核对结果' }).click(); await expect(dialog().locator('.ca-drop-list li')).toContainText('已新建');
    assert.equal(count.create, created + 1, '不应再次新建');
    const rows = (await api('/project-assets/assets?project_id=' + project.id + '&kind=character&q=' + encodeURIComponent('新人物乙'))).items; assert.equal(rows.length, 1);
    const a = await api('/project-assets/assets/' + rows[0].id); assert.equal(a.looks.length, 1); assert.equal(a.looks[0].name, '默认'); assert.equal(live(a).length, 1); assert.equal(a.looks[0].default_image_id, live(a)[0].id);
    await dialog().getByRole('button', { name: '完成', exact: true }).click(); await expect(work().locator('.ca-name-input')).toHaveValue('新人物乙'); await page.unrouteAll({ behavior: 'wait' });
  });

  await check('新建时同名被拒绝：继续处理不会把图片加到已有同名人物，改名后才新建', async () => {
    const before = await api('/project-assets/assets/' + hero.id), created = count.create;
    await dropFiles(work().locator('.ca-gallery'), ['陈川.png']); await expect(dialog().getByLabel('名称：陈川.png')).toHaveValue('陈川'); await dialog().getByRole('button', { name: /^新建 1 个人物/ }).click();
    const item = dialog().locator('.ca-drop-list li'); await expect(item).toContainText('本项目已有同名人物“陈川”'); await expect(item).toContainText('未完成');
    await dialog().locator('footer').getByRole('button', { name: '继续处理' }).click(); await expect(item).toContainText('本项目已有同名人物“陈川”'); await expect(item).toContainText('未完成');
    let same = await api('/project-assets/assets/' + hero.id); assert.equal(same.revision, before.revision, '已有同名人物不应被修改'); assert.equal(live(same).length, live(before).length); assert.equal(same.looks[0].default_image_id, coverId);
    assert.equal(count.create, created, '名称已存在时不发新建请求');
    await dialog().getByLabel('名称：陈川.png').fill('陈川二'); await dialog().locator('footer').getByRole('button', { name: '继续处理' }).click(); await expect(item).toContainText('已新建');
    same = await api('/project-assets/assets/' + hero.id); assert.equal(same.revision, before.revision); assert.equal(live(same).length, live(before).length);
    const rows = (await api('/project-assets/assets?project_id=' + project.id + '&kind=character&q=' + encodeURIComponent('陈川二'))).items.filter(a => a.name === '陈川二'); assert.equal(rows.length, 1); assert.equal(live(await api('/project-assets/assets/' + rows[0].id)).length, 1);
    await dialog().getByRole('button', { name: '完成', exact: true }).click(); await expect(dialog()).toHaveCount(0); await expect(work().locator('.ca-name-input')).toHaveValue('陈川二'); await expect(work()).toHaveAttribute('aria-busy', 'false');
  });

  await check('用户主动再次拖入同一张图仍可选择使用原图（不做全局去重）', async () => {
    const before = await api('/project-assets/assets/' + hero.id);
    await dropFiles(card('陈川'), ['上传丢回应.png']); await dialog().getByRole('button', { name: '添加图片' }).click();
    await expect(dialog().locator('.ca-drop-list li')).toContainText('请选择使用原图或继续导入'); await dialog().getByRole('button', { name: '使用原图' }).click(); await expect(dialog().locator('.ca-drop-list li')).toContainText('已添加');
    assert.equal(live(await api('/project-assets/assets/' + hero.id)).length, live(before).length + 1);
    await dialog().getByRole('button', { name: '完成', exact: true }).click();
  });
  assert.deepEqual(errors, []);
  passed = true;
} catch (e) { if (page) await page.screenshot({ path: path.join(temp, 'failure.png'), fullPage: true }).catch(() => {}); console.error('失败截图：' + path.join(temp, 'failure.png')); throw e; }
finally {
  await browser?.close();
  if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM');
  let timer; try { await Promise.race([exited, new Promise((_, reject) => timer = setTimeout(() => reject(Error('Owned app did not exit')), 15000))]); } finally { clearTimeout(timer); }
  console.log(JSON.stringify({ passed, checks, count }));
  if (passed) await fs.rm(temp, { recursive: true, force: true });
}
