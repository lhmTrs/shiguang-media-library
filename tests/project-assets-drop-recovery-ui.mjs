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
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal_item'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
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

  await check('新建资料丢回应：不自动认领，用户明确选择后才添加；不重复新建，新人物自动建默认造型', async () => {
    const dropped = await dropResponseOnce(r => r.method() === 'POST' && r.url().endsWith('/project-assets/assets')), created = count.create;
    await dropFiles(work().locator('.ca-gallery'), ['新人物乙.png']); await dialog().getByRole('button', { name: /^新建 1 个人物/ }).click();
    await expect(dialog().locator('.ca-drop-list li')).toContainText('结果待核对'); assert.ok(dropped());
    await dialog().locator('footer').getByRole('button', { name: '核对结果' }).click(); const item = dialog().locator('.ca-drop-list li');
    await expect(item).toContainText('无法确认是否由这次操作建立'); await expect(item.getByRole('group', { name: '待确认的同名资料' })).toContainText('新人物乙');
    const rows0 = (await api('/project-assets/assets?project_id=' + project.id + '&kind=character&q=' + encodeURIComponent('新人物乙'))).items; assert.equal(rows0.length, 1); assert.equal(live(await api('/project-assets/assets/' + rows0[0].id)).length, 0, '未选择前不改动候选资料'); assert.equal(count.content, 2, '未选择前不上传');
    page.once('dialog', d => d.accept()); await item.getByRole('button', { name: '使用这份资料并添加图片' }).click(); await expect(item).toContainText('已按你的选择加到所选资料');
    assert.equal(count.create, created + 1, '不应再次新建');
    const a = await api('/project-assets/assets/' + rows0[0].id); assert.equal(a.looks.length, 1); assert.equal(a.looks[0].name, '默认'); assert.equal(live(a).length, 1); assert.equal(a.looks[0].default_image_id, live(a)[0].id);
    await dialog().getByRole('button', { name: '完成', exact: true }).click(); await expect(work().locator('.ca-name-input')).toHaveValue('新人物乙'); await expect(work()).toHaveAttribute('aria-busy', 'false'); await page.unrouteAll({ behavior: 'wait' });
  });

  await check('并发同名：其他会话先建立同名人物、本页 409 回应丢失，核对后不认领、不改动对方资料', async () => {
    // 复现验收反例：预检查为空 → 其他会话建立同名人物（含默认造型）→ 本页 POST 真实到达后端得到 409 → 只丢弃这份回应
    let other, dropped = false;
    await page.route('**/api/project-assets/assets', async route => {
      if (dropped || route.request().method() !== 'POST') return route.fallback(); dropped = true;
      other = await api('/project-assets/assets', { project_id: project.id, kind: 'character', name: '并发同名' }); const lid = crypto.randomUUID();
      other = await api('/project-assets/assets/' + other.id, { asset: { ...other, default_look_id: lid, looks: [{ id: lid, name: '对方造型', description: '', tags: [], default_image_id: null, archived_at: null }] }, expected_revision: other.revision }, 'PUT');
      const response = await route.fetch(); assert.equal(response.status(), 409); await route.abort('failed');
    });
    const content = count.content;
    await dropFiles(work().locator('.ca-gallery'), ['并发同名.png']); await dialog().getByRole('button', { name: /^新建 1 个人物/ }).click();
    const item = dialog().locator('.ca-drop-list li'); await expect(item).toContainText('结果待核对'); assert.ok(dropped);
    for (let i = 0; i < 2; i++) { await dialog().locator('footer').getByRole('button', { name: '核对结果' }).click(); await expect(item).toContainText('无法确认是否由这次操作建立'); }
    let same = await api('/project-assets/assets/' + other.id); assert.equal(same.revision, other.revision, '对方资料版本不变'); assert.equal(live(same).length, 0); assert.equal(same.looks[0].default_image_id, null); assert.equal(count.content, content, '核对时不上传');
    await dialog().getByLabel('名称：并发同名.png').fill('并发同名-本窗口'); await dialog().locator('footer').getByRole('button', { name: '核对结果' }).click(); await expect(item).toContainText('已新建');
    same = await api('/project-assets/assets/' + other.id); assert.equal(same.revision, other.revision); assert.equal(live(same).length, 0); assert.equal(same.looks[0].default_image_id, null);
    const mine = (await api('/project-assets/assets?project_id=' + project.id + '&kind=character&q=' + encodeURIComponent('并发同名-本窗口'))).items.filter(a => a.name === '并发同名-本窗口'); assert.equal(mine.length, 1); assert.equal(live(await api('/project-assets/assets/' + mine[0].id)).length, 1);
    await dialog().getByRole('button', { name: '完成', exact: true }).click(); await expect(dialog()).toHaveCount(0); await expect(work()).toHaveAttribute('aria-busy', 'false'); await page.unrouteAll({ behavior: 'wait' });
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
  await check('明确人物_造型只拆第一个下划线，人工编辑与切换类别保持，原文件名不改', async () => {
    await dropFiles(work().locator('.ca-gallery'), ['预填人物_长袍_三视图.png']);
    await expect(dialog().getByLabel('名称：预填人物_长袍_三视图.png')).toHaveValue('预填人物');
    await expect(dialog().getByLabel('造型：预填人物_长袍_三视图.png')).toHaveValue('长袍_三视图');
    await dialog().getByLabel('名称：预填人物_长袍_三视图.png').fill('人工人物');
    await dialog().getByLabel('造型：预填人物_长袍_三视图.png').fill('人工造型_完整保留');
    await dialog().getByLabel('新建类别').selectOption('prop');
    await expect(dialog().getByLabel('名称：预填人物_长袍_三视图.png')).toHaveValue('人工人物');
    await dialog().getByLabel('新建类别').selectOption('character');
    await expect(dialog().getByLabel('造型：预填人物_长袍_三视图.png')).toHaveValue('人工造型_完整保留');
    await dialog().getByRole('button', {name:/^新建 1 个人物/}).click();
    await expect(dialog().locator('.ca-drop-list li')).toContainText('已新建');
    const rows = (await api('/project-assets/assets?project_id='+project.id+'&kind=character&q='+encodeURIComponent('人工人物'))).items;
    const a = await api('/project-assets/assets/'+rows[0].id);
    assert.equal(a.looks[0].name,'人工造型_完整保留'); assert.equal(live(a)[0].last_known_name,'预填人物_长袍_三视图.png');
    await dialog().getByRole('button',{name:'完成',exact:true}).click(); await expect(work()).toHaveAttribute('aria-busy','false');
  });
  await check('已有人物卡片落点优先，文件名不覆盖人物、已选造型或已有代表图', async () => {
    const before = await api('/project-assets/assets/'+hero.id);
    await dropFiles(card('陈川'), ['其他人_全新造型.png']);
    await expect(dialog()).toContainText('添加到“陈川”'); await expect(dialog().getByLabel('放进造型')).toHaveValue(lookId);
    await dialog().getByRole('button',{name:'添加图片',exact:true}).click(); await expect(dialog().locator('.ca-drop-list li')).toContainText('已添加');
    const a = await api('/project-assets/assets/'+hero.id);
    assert.equal(a.name,'陈川'); assert.equal(a.looks.length,before.looks.length); assert.equal(a.looks[0].default_image_id,coverId);
    assert.equal(live(a).at(-1).look_id,lookId);
    await dialog().getByRole('button',{name:'完成',exact:true}).click(); await expect(work()).toHaveAttribute('aria-busy','false');
  });
  await check('相机名不自动建立人物，补充名称后可以继续；不按长度强行改归属', async () => {
    const creates=count.create;
    await dropFiles(work().locator('.ca-gallery'), ['IMG_0012.png']);
    await expect(dialog().getByLabel('名称：IMG_0012.png')).toHaveValue('');
    await dialog().getByRole('button',{name:/^新建 1 个人物/}).click(); assert.equal(count.create,creates);
    await dialog().getByLabel('名称：IMG_0012.png').fill('明确命名');
    await dialog().getByRole('button',{name:/^新建 1 个人物/}).click(); await expect(dialog().locator('.ca-drop-list li')).toContainText('已新建');
    await dialog().getByRole('button',{name:'完成',exact:true}).click(); await expect(work()).toHaveAttribute('aria-busy','false');
  });
  await check('指定造型创建成功但丢回应，按固定造型编号恢复，不增建默认造型或重复上传', async () => {
    let dropped=false;
    await page.route('**/api/project-assets/assets/*',async route=>{
      if(dropped||route.request().method()!=='PUT'||!route.request().postDataJSON()?.asset?.looks?.some(l=>l.name==='外套_新款'))return route.fallback();
      dropped=true; await route.fetch(); await route.abort('failed');
    });
    const content=count.content;
    await dropFiles(work().locator('.ca-gallery'), ['造型恢复人物_外套_新款.png']);
    await dialog().getByRole('button',{name:/^新建 1 个人物/}).click(); await expect(dialog().locator('.ca-drop-list li')).toContainText('结果待核对'); assert.ok(dropped);
    await expect(dialog().getByLabel('造型：造型恢复人物_外套_新款.png')).toBeDisabled();
    await dialog().locator('footer').getByRole('button',{name:'核对结果'}).click(); await expect(dialog().locator('.ca-drop-list li')).toContainText('已新建');
    const rows=(await api('/project-assets/assets?project_id='+project.id+'&kind=character&q='+encodeURIComponent('造型恢复人物'))).items;
    const a=await api('/project-assets/assets/'+rows[0].id); assert.equal(a.looks.length,1);assert.equal(a.looks[0].name,'外套_新款');assert.equal(live(a).length,1);assert.equal(count.content,content+1);
    await dialog().getByRole('button',{name:'完成',exact:true}).click(); await expect(work()).toHaveAttribute('aria-busy','false');await page.unrouteAll({behavior:'wait'});
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
