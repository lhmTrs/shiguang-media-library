// 第二期 P2a 前后端组合：真实本地服务（含作用域接口），不替身任何接口。
// 走通：全剧新建与编辑 → 集视图继承与本集覆盖 → 本集自有新建 → 本季设定 → 提升到全剧 → 同名继承 → 全剧归档默认造型（选替代）。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { projectInBar } from './helpers/path-bar.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-scope-real-'));
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const checks = [], errors = [], failures = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal'), CODEX_HOME: path.join(temp, 'no-codex'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', MEDIA_CODEX_AUTOCONNECT: '0', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body, method) { const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json(); assert.ok(response.ok, p + ' ' + JSON.stringify(data)); return data; }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const rid = () => crypto.randomUUID();
const work = () => page.getByRole('region', { name: '项目资产库' });
const list = () => work().locator('section.ca-gallery').first();
const cardOf = name => list().locator('.ca-card').filter({ has: page.locator('strong', { hasText: new RegExp('^' + name.replace(/[()（）]/g, '.') + '$') }) }).first();
const names = async () => { await expect(list()).toHaveAttribute('aria-busy', 'false'); return (await list().locator('.ca-card:not(.ca-card-add) strong').allTextContents()).sort(); };
const scopeSwitch = () => work().getByRole('group', { name: '看哪里的资产' });
const nav = name => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true }).click();
const createDlg = () => page.getByRole('dialog', { name: '新建资产' });
const openDetail = async name => { await cardOf(name).click(); await expect(work().locator('.ca-name-input')).toHaveValue(name); };
async function pickEpisode(id) { await projectInBar(page).getByRole('navigation', { name: '当前项目' }).getByRole('button').last().click(); await projectInBar(page).locator(`.ppb-option[data-target-project="${id}"]`).click(); await expect(projectInBar(page)).toHaveAttribute('data-project', id); }
page = null;

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  const s = await api('/project-series', { name: '穿越计', software: 'jianying', request_id: rid() });
  const q = await api(`/project-series/${s.id}/seasons`, { request_id: rid() });
  const eps = []; for (let i = 1; i <= 2; i++) eps.push((await api(`/project-series/${s.id}/episodes`, { season_id: q.id, expected_episode_no: i, request_id: rid() })).project);
  const ctx = await api(`/projects/${eps[0].id}/asset-context`); assert.equal(ctx.series?.id, s.id, '真实 asset-context 应返回所属剧');

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
  await context.addInitScript(() => { try { localStorage.setItem('shiguang.refreshSeconds', '0'); } catch {} });
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  page.on('response', r => { if (r.url().includes('/api/project-assets/scopes/') && r.status() >= 400) failures.push(r.status() + ' ' + r.request().method() + ' ' + new URL(r.url()).pathname); });
  await page.goto(origin + '/#/projects'); await expect(projectInBar(page)).toHaveAttribute('data-project', /./);
  await pickEpisode(eps[0].id); await nav('项目资产');

  await check('全剧视图新建人物并加两个造型，保存走剧作用域', async () => {
    await expect(scopeSwitch().getByRole('button', { name: '全剧', exact: true })).toBeVisible();
    await scopeSwitch().getByRole('button', { name: '全剧', exact: true }).click(); await expect(work().locator('.ca-series-note')).toBeVisible();
    await work().getByRole('button', { name: /^新建/ }).first().click(); await createDlg().getByLabel('新资产名称').fill('李四'); await createDlg().getByRole('button', { name: '创建并编辑' }).click();
    await expect(createDlg()).toHaveCount(0); await expect(work().locator('.ca-name-input')).toHaveValue('李四');
    await work().getByRole('navigation', { name: '详情分区' }).getByRole('button', { name: '造型与参考图', exact: true }).click();
    await work().getByRole('button', { name: '新增造型', exact: true }).click(); await work().getByRole('button', { name: '新增造型', exact: true }).click();
    await work().getByLabel('基础信息', { exact: true }).fill('全剧的李四'); await work().getByRole('button', { name: '保存资料', exact: true }).click();
    await expect(work().getByRole('button', { name: '保存资料', exact: true })).toBeDisabled();
    const detail = await api(`/project-assets/scopes/series/${s.id}/assets?kind=character`); const lisi = detail.items.find(i => i.asset.name === '李四');
    assert.equal(lisi.owner.type, 'series'); assert.equal(lisi.asset.looks.filter(l => !l.archived_at).length, 2); assert.equal(lisi.asset.base_info, '全剧的李四');
  });

  // 合成 1×1 PNG（每次内容不同，避免查重弹窗）
  const png = n => { const b = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'); return Buffer.concat([b, Buffer.from('synthetic-' + n)]); };
  const fileInput = () => work().locator('input[type=file][aria-label="选择一张参考图片"]');
  const seriesLisi = async () => (await api(`/project-assets/scopes/series/${s.id}/assets?kind=character`)).items.find(i => i.asset.name === '李四').asset;
  await check('全剧视图从本地文件导入：落到剧的图片文件夹，保存后绑定，其他集继承默认图', async () => {
    const before = await seriesLisi(), look = before.looks.filter(l => !l.archived_at)[0];
    await work().locator('.ca-look-list button').filter({ hasText: look.name }).first().click();
    await fileInput().setInputFiles({ name: '全剧参考.png', mimeType: 'image/png', buffer: png(1) });
    await expect(work().getByRole('button', { name: '设置参考图片：全剧参考.png' })).toBeVisible();
    assert.equal((await seriesLisi()).images.length, 0, '已复制不等于已绑定：保存前不应有绑定');
    await work().getByRole('button', { name: '保存资料', exact: true }).click(); await expect(work().getByRole('button', { name: '保存资料', exact: true })).toBeDisabled();
    const after = await seriesLisi(), bound = after.images.find(b => b.look_id === look.id && !b.archived_at); assert.ok(bound, '保存后应绑定到全剧人物的造型');
    const inEp2 = await api(`/project-assets/scopes/episode/${eps[1].id}/assets/${after.id}`);
    assert.equal(inEp2.effective.default_images[look.id].value, bound.id, '第 2 集应继承全剧默认图');
  });

  await check('集里从本地文件追加图片：上传到本集，回执 → 预览 → 确认后写到全剧', async () => {
    await scopeSwitch().getByRole('button').first().click(); await expect.poll(names).toEqual(['李四']); await openDetail('李四');
    await work().getByRole('navigation', { name: '详情分区' }).getByRole('button', { name: '造型与参考图', exact: true }).click();
    const look = (await seriesLisi()).looks.filter(l => !l.archived_at)[1]; // 两个造型同名（都叫「新造型」），按顺序选第二个
    await work().locator('.ca-look-list button').nth(1).click();
    await fileInput().setInputFiles({ name: '本集追加.png', mimeType: 'image/png', buffer: png(2) });
    const confirm = page.getByRole('dialog', { name: '确认追加图片' }); await expect(confirm).toBeVisible();
    if (await confirm.getByRole('checkbox').count()) { await expect(confirm.getByRole('button', { name: '确认追加' })).toBeDisabled(); await confirm.getByRole('checkbox').check(); }
    await confirm.getByRole('button', { name: '确认追加' }).click();
    await expect(confirm, '追加失败：' + await page.getByRole('alert').allTextContents().catch(() => [])).toHaveCount(0, { timeout: 8000 }).catch(async e => { throw Error('追加确认没有成功：' + (await page.getByRole('alert').allTextContents()).join(' / ')); });
    const after = await seriesLisi(); assert.ok(after.images.some(b => b.look_id === look.id && !b.archived_at), '确认后全剧人物的这个造型应有新图：' + JSON.stringify({ look: look.id, looks: after.looks.map(l => [l.id, l.name]), images: after.images.map(b => [b.look_id, b.last_known_name, b.archived_at]) }));
    await scopeSwitch().getByRole('button', { name: '全剧', exact: true }).click(); await expect(work().locator('.ca-series-note')).toBeVisible();
  });

  await check('集视图：全剧人物带「全剧」标记、只读；本集设置改默认造型来源变本集，恢复后回到上层', async () => {
    await scopeSwitch().getByRole('button').first().click(); await expect.poll(names).toEqual(['李四']);
    await expect(cardOf('李四').locator('.ca-owner-src')).toHaveText('全剧'); await openDetail('李四');
    await expect(work().locator('.ca-name-input')).toBeDisabled(); const panel = work().getByRole('region', { name: '本集设置' }); await expect(panel).toBeVisible();
    const lookRow = panel.getByRole('group', { name: '默认造型' }); const choices = lookRow.locator('.ca-override-choices button');
    await expect(choices).toHaveCount(2); const other = (await choices.nth(0).getAttribute('aria-pressed')) === 'true' ? choices.nth(1) : choices.nth(0);
    await other.click(); await expect(lookRow.locator('.ca-src-tag')).toHaveText('本集'); await expect(other).toHaveAttribute('aria-pressed', 'true');
    await lookRow.getByRole('button', { name: /恢复上层/ }).click(); await expect(lookRow.locator('.ca-src-tag')).toHaveText('全剧');
  });

  await check('集视图新建本集自有人物；同名全剧人物时询问继承', async () => {
    await work().getByRole('button', { name: /^新建/ }).first().click(); await createDlg().getByLabel('新资产名称').fill('卖油郎'); await createDlg().getByRole('button', { name: '创建并编辑' }).click();
    await expect(createDlg()).toHaveCount(0); await expect(work().locator('.ca-name-input')).toHaveValue('卖油郎'); await expect(cardOf('卖油郎').locator('.ca-owner-src')).toHaveText('只在本集');
    await work().getByRole('button', { name: /^新建/ }).first().click(); await createDlg().getByLabel('新资产名称').fill('李四'); await createDlg().getByRole('button', { name: '创建并编辑' }).click();
    await expect(createDlg().getByRole('alert')).toContainText('全剧已经有「李四」'); await createDlg().getByRole('button', { name: /继承全剧的/ }).click();
    await expect(createDlg()).toHaveCount(0); await expect(work().locator('.ca-name-input')).toHaveValue('李四');
  });

  await check('本季设定：新增本季默认造型，列表显示；恢复全剧后清空', async () => {
    await work().getByRole('button', { name: /季设定$/ }).click(); const dlg = page.getByRole('dialog', { name: /本季设定$/ });
    await expect(dlg).toContainText('这一季还没有单独设置');
    await dlg.getByLabel('选择资产').selectOption({ label: '李四' }); await dlg.getByLabel('选择设置项').selectOption({ index: 1 });
    const vals = await dlg.getByLabel('选择本季的值').locator('option').allTextContents(); assert.ok(vals.length >= 3, '应有两个造型可选：' + vals);
    await dlg.getByLabel('选择本季的值').selectOption({ index: 2 }); await dlg.getByRole('button', { name: '设为本季' }).click();
    await expect(dlg.getByRole('row').filter({ hasText: '李四' })).toContainText('默认造型');
    await dlg.getByRole('button', { name: /^恢复全剧：李四/ }).click(); await expect(dlg).toContainText('这一季还没有单独设置');
    await dlg.getByRole('button', { name: '关闭' }).click();
  });

  await check('提升到全剧：本集自有人物先看影响，确认后变成全剧共享，其他集也能看到', async () => {
    await openDetail('卖油郎'); await work().getByRole('button', { name: '资料操作', exact: true }).click(); await work().getByRole('menuitem', { name: '提升到全剧…' }).click();
    const dlg = page.getByRole('dialog', { name: '把「卖油郎」提升到全剧' }); await expect(dlg).toBeVisible(); await expect(dlg.getByRole('button', { name: '确认提升' })).toBeEnabled();
    await dlg.getByRole('button', { name: '确认提升' }).click(); await expect(dlg).toHaveCount(0);
    await expect(cardOf('卖油郎').locator('.ca-owner-src')).toHaveText('全剧');
    await pickEpisode(eps[1].id); await expect.poll(names).toEqual(['卖油郎', '李四']);
  });

  await check('全剧归档默认造型：要先选替代，选好后重新预览再确认', async () => {
    await scopeSwitch().getByRole('button', { name: '全剧', exact: true }).click(); await expect.poll(names).toEqual(['卖油郎', '李四']);
    await openDetail('李四'); await work().getByRole('navigation', { name: '详情分区' }).getByRole('button', { name: '造型与参考图', exact: true }).click();
    const lisi = (await api(`/project-assets/scopes/series/${s.id}/assets?kind=character`)).items.find(i => i.asset.name === '李四').asset;
    const def = lisi.looks.find(l => l.id === lisi.default_look_id);
    await work().locator('.ca-look-list button').filter({ hasText: def.name }).first().click(); await work().locator('.ca-look-config > summary').click();
    await work().getByRole('button', { name: '归档造型', exact: true }).click();
    const dlg = page.getByRole('dialog', { name: /^归档造型/ }); await expect(dlg).toBeVisible();
    if (await dlg.getByLabel('选择替代项').count()) { await expect(dlg.getByRole('button', { name: '确认归档' })).toBeDisabled(); await dlg.getByLabel('选择替代项').selectOption({ index: 1 }); }
    await expect(dlg.getByRole('button', { name: '确认归档' })).toBeEnabled(); await dlg.getByRole('button', { name: '确认归档' }).click(); await expect(dlg).toHaveCount(0);
    const after = (await api(`/project-assets/scopes/series/${s.id}/assets?kind=character`)).items.find(i => i.asset.name === '李四').asset;
    assert.ok(after.looks.find(l => l.id === def.id).archived_at, '原默认造型应已归档'); assert.notEqual(after.default_look_id, def.id, '默认造型应换成替代项');
  });

  assert.deepEqual(failures, [], '作用域接口不应返回错误');
  assert.deepEqual(errors, [], '页面不应出现脚本错误');
  passed = true;
} finally {
  if (!passed) { console.error('scope failures:', failures); console.error(logs.slice(-2500)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'creative-scope-real-failure.png') }).catch(() => {}); }
  await browser?.close(); child.kill('SIGTERM'); let timer; if (await Promise.race([exited, new Promise(r => timer = setTimeout(() => r('timeout'), 10000))]) === 'timeout') { child.kill('SIGKILL'); await exited; } clearTimeout(timer);
  await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
