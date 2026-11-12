// 废片收纳（#55，合同 v1）的前端检查。
// 后端尚未实现：收纳处角色（folderRoles / role / inRejectArea / folderId=reject）、/folders/reject/preview、/folders/reject、
// kind:'move-videos' + unbindAdoptions 的预览与执行、以及“移回”的 move-video 都由这里的 page.route 按合同 v1 字段模拟。
// 列表的视频与文件夹来自真实 App（合成视频），只叠加模拟的角色与收纳状态。只验证前端行为，不代表接口已接通。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { selectProjectInBar } from './helpers/path-bar.mjs';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'project-videos-reject-'))), clips = path.join(temp, '合成视频'); await fs.mkdir(clips);
const ffmpeg = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
async function clip(name, color) {
  const file = path.join(clips, name);
  const run = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=96x64:r=8:d=2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', file]);
  assert.equal(run.status, 0, run.stderr?.toString()); return file;
}
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const checks = [], errors = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal_item'), CODEX_HOME: path.join(temp, 'codex'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_CODEX_AUTOCONNECT: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
const work = () => page.getByRole('region', { name: '项目生成视频' }), modal = () => page.locator('.pv-modal');
const card = id => work().locator(`.pv-card[data-video-id="${id}"]`);
const detail = () => work().getByRole('complementary', { name: '视频详情' });
const chip = () => work().locator('.pv-folder-reject');
const banner = () => work().locator('.pv-banner', { hasText: '废片收纳：' });
const bar = () => work().getByRole('navigation', { name: /视频文件夹/ });

// ---- 合同 v1 模拟状态 ----
const mock = { role: { revision: 0, id: null }, rejected: new Set(), adopted: {}, plans: {}, receipts: {}, posts: [], next: '', executed: [], holdPreview: null, holdRole: null, conflictIds: [] };
const sorted = a => [...a].sort();
async function installMocks() {
  const base = `/api/project-videos/projects/${projectId}`;
  // 列表：真实数据 + 模拟角色与收纳状态
  await page.route(url => url.pathname === base, async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    const url = new URL(route.request().url()), view = url.searchParams.get('folderId') || 'all';
    if (view === 'reject') url.searchParams.set('folderId', 'all');
    const res = await route.fetch({ url: url.toString() }); const data = await res.json();
    if (!res.ok()) return route.fulfill({ status: res.status(), json: data });
    const { role, rejected } = mock;
    data.folders = data.folders.map(f => ({ ...f, role: f.id === role.id ? 'reject' : null }));
    data.videos = data.videos.map(v => ({ ...v, adoptedShots: mock.adopted[v.id] || v.adoptedShots, inRejectArea: rejected.has(v.id), folderId: rejected.has(v.id) ? role.id : v.folderId }))
      .filter(v => view === 'reject' ? v.inRejectArea : !v.inRejectArea);
    data.folderRoles = { revision: role.revision, rejectFolderId: role.id, rejectVideoCount: rejected.size, needsReview: !!role.id && !data.folders.some(f => f.id === role.id) };
    await route.fulfill({ json: data });
  });
  await page.route(url => url.pathname.startsWith(base + '/folders/reject') || url.pathname.startsWith(base + '/operations'), async route => {
    const req = route.request(), suffix = new URL(req.url()).pathname.slice(base.length), body = req.postData() ? JSON.parse(req.postData()) : null;
    if (req.method() === 'GET') { const id = decodeURIComponent(suffix.split('/').pop()); return mock.receipts[id] ? route.fulfill({ json: mock.receipts[id] }) : route.fallback(); }
    if (suffix === '/folders/reject/preview') {
      mock.posts.push({ kind: 'role-preview', body });
      if (mock.holdRole) { const gate = mock.holdRole; mock.holdRole = null; gate.reached(); await gate.release; }
      const plan = { requestId: body.requestId, previewHash: 'h-' + body.requestId, ready: true, expectedRolesRevision: mock.role.revision, adoptionStamp: 'stamp',
        roleChange: { beforeFolderId: mock.role.id, afterFolderId: body.create ? null : body.folderId, willCreate: !!body.create }, affectedShots: [], rejectVideoCount: body.folderId ? 7 : undefined };
      mock.plans[body.requestId] = { kind: 'role', plan }; return route.fulfill({ json: plan });
    }
    if (suffix === '/folders/reject') {
      mock.posts.push({ kind: 'role-commit', body }); const p = mock.plans[body.requestId]?.plan;
      assert.ok(p && body.previewHash === p.previewHash && body.confirmRoleChange === true, '角色执行必须带原预览与明确确认');
      mock.role = { revision: mock.role.revision + 1, id: p.roleChange.willCreate ? 'created' : p.roleChange.afterFolderId };
      const receipt = { requestId: body.requestId, status: 'ready', description: '废片收纳处已更新', folderId: mock.role.id };
      mock.receipts[body.requestId] = receipt; return route.fulfill({ json: receipt });
    }
    if (suffix === '/operations/preview' && body.kind === 'move-videos') {
      mock.posts.push({ kind: 'move-preview', body });
      if (mock.holdPreview) { const gate = mock.holdPreview; mock.holdPreview = null; gate.reached(); await gate.release; }
      const shots = body.sourceIds.flatMap(id => (mock.adopted[id] || []).map(s => ({ ...s, sourceIds: [id] })));
      // 与收纳处里已有的同名视频冲突：覆盖会解除目标的镜 12；按 sourceId 选择
      const conflicts = body.sourceIds.filter(id => mock.conflictIds.includes(id)).map(id => ({ key: id, name: '戊.mp4', sourceName: '戊.mp4', targetName: '戊.mp4', targetVideoId: 'old-target', adoptedShots: [{ id: 'shot-12', number: '12' }], choice: body.choices?.[id] }));
      const overwrite = conflicts.filter(x => body.choices?.[x.key] === 'overwrite').flatMap(x => x.adoptedShots.map(s => ({ ...s, sourceIds: ['old-target'] })));
      const plan = { requestId: body.requestId, previewHash: 'm-' + body.requestId, description: `将 ${body.sourceIds.length} 个视频移入废片`, conflicts, files: body.sourceIds.length, folders: 0,
        ready: conflicts.every(x => body.choices?.[x.key]), affectedShots: [...shots, ...overwrite], sourceUnbindShots: shots, overwriteTargetUnbindShots: overwrite, willUnbindAdoptions: true, rolesRevision: mock.role.revision, adoptionStamp: 'stamp' };
      mock.plans[body.requestId] = { kind: 'move', plan, sourceIds: body.sourceIds, choices: body.choices || {} }; return route.fulfill({ json: plan });
    }
    if (suffix === '/operations/preview' && body.kind === 'move-video' && mock.rejected.has(body.sourceId)) { // 移回（普通 move-video）
      mock.posts.push({ kind: 'back-preview', body });
      const plan = { requestId: body.requestId, previewHash: 'b-' + body.requestId, description: '移回项目根目录', conflicts: [], affectedShots: [], files: 1, folders: 0, ready: true };
      mock.plans[body.requestId] = { kind: 'back', plan, sourceId: body.sourceId }; return route.fulfill({ json: plan });
    }
    if (suffix === '/operations' && mock.plans[body?.requestId]) {
      const entry = mock.plans[body.requestId]; mock.posts.push({ kind: entry.kind + '-commit', body });
      if (entry.kind === 'back') { mock.rejected.delete(entry.sourceId); const receipt = { requestId: body.requestId, status: 'ready', description: '已移回' }; mock.receipts[body.requestId] = receipt; return route.fulfill({ json: receipt }); }
      assert.deepEqual(sorted(body.confirmedUnbindShotIds), sorted(entry.plan.affectedShots.map(s => s.id)), '确认的镜号必须与预览并集完全一致');
      const mode = mock.next; mock.next = '';
      if (mode === '409') return route.fulfill({ status: 409, json: { error: '测试：预览已失效，请重新核对', code: 'PREVIEW_REQUIRED' } }); // 明确拒绝：没有执行
      mock.executed.push({ requestId: body.requestId, choices: entry.choices });
      // 后台整批一次提交：失败时逐项回退，不产生部分提交
      const items = entry.sourceIds.map((id, i) => mode === 'failed'
        ? i === entry.sourceIds.length - 1 ? { sourceId: id, status: 'failed', error: '测试：目标目录暂不可写' } : { sourceId: id, status: 'rolled-back' }
        : { sourceId: id, status: 'ready', unboundShotIds: (mock.adopted[id] || []).map(s => s.id) });
      if (mode !== 'failed') for (const it of items) { mock.rejected.add(it.sourceId); delete mock.adopted[it.sourceId]; }
      const receipt = { requestId: body.requestId, status: mode === 'failed' ? 'failed' : 'ready', description: '移入废片', items,
        error: mode === 'failed' ? '测试：有视频没有移动，已全部回退' : null, unboundShotIds: mode === 'failed' ? [] : entry.plan.affectedShots.map(s => s.id) };
      mock.receipts[body.requestId] = receipt;
      if (mode === 'drop') return route.abort('failed'); // 已执行，只丢回应
      if (mode === '500') return route.fulfill({ status: 500, json: { error: '测试：执行后服务器出错' } }); // 已执行，回应是 500
      return route.fulfill({ json: receipt });
    }
    return route.fallback();
  });
}
const posts = kind => mock.posts.filter(p => p.kind === kind);

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  projectId = (await api('/projects', { name: '废片短片' })).id;
  await api(pv('/folders'), { requestId: crypto.randomUUID(), parentId: 'root', name: '废片' }); // 用户手建的同名文件夹
  await api(pv('/folders'), { requestId: crypto.randomUUID(), parentId: 'root', name: '第一场' });
  const folders = (await api(pv('?folderId=all'))).folders, manual = folders.find(f => f.name === '废片').id;
  const ids = {}; for (const [name, color] of [['甲.mp4', 'green'], ['乙.mp4', 'brown'], ['丙.mp4', 'gray'], ['丁.mp4', 'navy'], ['戊.mp4', 'purple'], ['己.mp4', 'olive'], ['庚.mp4', 'teal']]) ids[name] = await seedVideo(await clip(name, color), 'root');
  const [A, B, C, D, E, F, G] = ['甲.mp4', '乙.mp4', '丙.mp4', '丁.mp4', '戊.mp4', '己.mp4', '庚.mp4'].map(n => ids[n]); mock.conflictIds = [E, G];
  mock.adopted[A] = [{ id: 'shot-3', number: '03' }];

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await installMocks();
  await page.goto(origin + '/#/project-videos'); await expect(work()).toBeVisible(); await selectProjectInBar(page, projectId);
  await expect(card(A)).toBeVisible();

  await check('没有收纳处：文件夹栏末尾有“废片 0”入口，废片视图说明尚未设置；同名文件夹不被自动当作收纳处', async () => {
    await expect(chip()).toContainText('废片'); await expect(chip()).toContainText('0');
    await expect(bar().getByRole('button', { name: '废片', exact: true })).toBeVisible(); // 手建的“废片”仍是普通文件夹
    await chip().click(); await expect(work()).toContainText('还没有设置废片收纳处');
    await bar().getByRole('button', { name: '项目根目录' }).click(); await expect(card(A)).toBeVisible();
  });

  await check('首次标记（详情 ⋯）：先确认把手建“废片”设为收纳处，再精确确认解除镜 03 的采用后移入', async () => {
    await card(A).click(); await detail().getByRole('button', { name: '视频操作' }).click(); await page.getByRole('menuitem', { name: /标记为废片/ }).click();
    await expect(modal()).toContainText('标记为废片（1 个）'); await expect(modal()).toContainText('项目还没有废片收纳处');
    await expect(modal().getByLabel('把现有文件夹设为收纳处（文件不搬动）')).toBeChecked(); // 预选手建的“废片”，仍需用户核对确认
    await modal().getByRole('button', { name: '核对影响' }).click(); await expect(modal()).toContainText('将把“废片”设为废片收纳处，里面的文件不搬动');
    await expect(modal()).toContainText('该文件夹（含子文件夹）现有 7 个视频'); // R5：读取 rejectVideoCount
    const set = modal().getByRole('button', { name: '设为收纳处' }); await expect(set).toBeDisabled();
    await modal().getByLabel('确认设置废片收纳处').check(); await set.click();
    await expect(modal()).toContainText('收纳处已准备'); await expect(modal()).toContainText('视频还没有移动');
    assert.equal(posts('role-commit')[0].body.confirmRoleChange, true); assert.deepEqual(posts('role-commit')[0].body.confirmedUnbindShotIds, []);
    assert.equal(posts('role-preview')[0].body.folderId, manual);
    await modal().getByRole('button', { name: /继续：核对移入影响/ }).click();
    await expect(modal()).toContainText('镜 03'); const go = modal().getByRole('button', { name: '移入废片' }); await expect(go).toBeDisabled();
    const mp = posts('move-preview').at(-1).body; assert.equal(mp.kind, 'move-videos'); assert.equal(mp.unbindAdoptions, true); assert.deepEqual(mp.sourceIds, [A]); assert.equal(mp.destinationFolderId, manual); assert.equal(mp.expectedRolesRevision, 1);
    await modal().getByLabel('我已核对上述镜号，确认解除这些采用关系').check();
    if (process.env.PV_SHOTS) await page.screenshot({ path: path.join(process.env.PV_SHOTS, 'reject-move.png') });
    await go.click();
    await expect(modal()).toContainText('已移入废片：1 个视频'); await expect(modal()).toContainText('解除 1 个镜号的采用');
    assert.deepEqual(posts('move-commit').at(-1).body.confirmedUnbindShotIds, ['shot-3']); assert.equal(posts('move-commit').at(-1).body.confirmUnbind, true);
    await modal().getByRole('button', { name: '完成' }).click(); await expect(modal()).toHaveCount(0);
    await expect(card(A)).toHaveCount(0); await expect(chip()).toContainText('1');
    await expect(bar().getByRole('button', { name: '废片', exact: true })).toHaveCount(0); // 收纳根不再作为普通文件夹显示
  });

  await check('普通“移动到…”不提供收纳处作为目标；拖到“废片”入口改走废片核对（不打开普通移动）', async () => {
    await card(B).click({ button: 'right' }); await page.getByRole('menuitem', { name: '移动到…' }).click();
    await expect(modal()).toContainText('移动视频'); const options = await modal().locator('select option').allTextContents();
    assert.ok(!options.some(o => o.includes('废片')), '目标列表不应包含收纳处：' + options.join(','));
    await expect(modal()).toContainText('要收纳为废片，请用“标记为废片…”'); await modal().getByRole('button', { name: '取消' }).click();
    await card(B).dragTo(chip()); await expect(modal()).toContainText('标记为废片（1 个）'); await expect(modal()).toContainText('没有受影响的采用镜号');
    await expect(modal()).not.toContainText('移动视频'); await page.keyboard.press('Escape'); await expect(modal()).toHaveCount(0);
  });

  await check('多选批量：回应丢失后待核对；收起、切页回来仍保留原请求，查询得到结果后看过才收起，只提交一次', async () => {
    await card(C).click(); await card(D).click({ modifiers: ['Meta'] });
    await work().getByRole('toolbar', { name: '已选视频操作' }).getByRole('button', { name: '标记为废片' }).click();
    await expect(modal()).toContainText('标记为废片（2 个）'); await expect(modal()).toContainText('将 2 个视频移入废片');
    mock.next = 'drop'; await modal().getByRole('button', { name: '移入废片' }).click();
    await expect(modal()).toContainText('结果待核对'); const requestId = posts('move-commit').at(-1).body.requestId; await expect(modal()).toContainText(requestId);
    assert.deepEqual(posts('move-commit').at(-1).body.confirmedUnbindShotIds, []);
    await page.keyboard.press('Escape'); await expect(banner()).toContainText('结果待核对');
    await page.getByRole('navigation').getByRole('button', { name: '分镜设计' }).first().click(); await expect(work()).toBeHidden();
    await page.getByRole('navigation').getByRole('button', { name: '生成视频' }).first().click(); await expect(work()).toBeVisible();
    await expect(banner()).toContainText(requestId);
    await banner().getByRole('button', { name: '查询原请求' }).click(); await expect(banner()).toContainText('已有结果，请查看');
    await expect(card(C)).toHaveCount(0); await expect(card(D)).toHaveCount(0);
    await banner().getByRole('button', { name: '打开' }).click(); await expect(modal()).toContainText('已移入废片：2 个视频');
    await modal().getByRole('button', { name: '完成' }).click(); await expect(banner()).toHaveCount(0);
    assert.equal(posts('move-commit').filter(p => p.body.requestId === requestId).length, 1, '不重发');
  });

  await check('整批失败已回退：逐项显示回退与失败原因，不显示已移入', async () => {
    await card(B).click({ button: 'right' }); await page.getByRole('menuitem', { name: '标记为废片…' }).click();
    await expect(modal()).toContainText('将 1 个视频移入废片'); mock.next = 'failed';
    await modal().getByRole('button', { name: '移入废片' }).click();
    await expect(modal()).toContainText('测试：有视频没有移动，已全部回退'); await expect(modal()).toContainText('没有移动 · 测试：目标目录暂不可写');
    await expect(modal()).not.toContainText('已移入废片：');
    await modal().getByRole('button', { name: '关闭' }).last().click(); await expect(card(B)).toBeVisible();
  });

  const conflictChoice = () => modal().getByLabel('冲突处理 戊.mp4');
  await check('改动冲突处理（R1）：旧核对与确认立即作废、不能执行；按新选择重新核对后执行的是新选择', async () => {
    await card(E).click({ button: 'right' }); await page.getByRole('menuitem', { name: '标记为废片…' }).click();
    await expect(modal()).toContainText('同名冲突');
    await conflictChoice().selectOption('overwrite'); await modal().getByRole('button', { name: '按所选冲突方式重新核对' }).click();
    await expect(modal()).toContainText('镜 12'); await modal().getByLabel('我已核对上述镜号，确认解除这些采用关系').check();
    const go = modal().getByRole('button', { name: '移入废片' }); await expect(go).toBeEnabled();
    const executed = mock.executed.length;
    await conflictChoice().selectOption('rename');
    await expect(modal()).toContainText('冲突处理方式已改变，原核对结果作废'); await expect(go).toBeDisabled();
    await go.click({ force: true }); assert.equal(mock.executed.length, executed, '旧的覆盖方案不能被执行');
    await modal().getByRole('button', { name: '按所选冲突方式重新核对' }).click();
    await expect(modal()).not.toContainText('冲突处理方式已改变'); await expect(modal()).toContainText('没有受影响的采用镜号');
    await go.click(); await expect(modal()).toContainText('已移入废片：1 个视频');
    assert.equal(mock.executed.at(-1).choices[E], 'rename', '执行的是重新核对后的“改名”'); assert.deepEqual(posts('move-commit').at(-1).body.confirmedUnbindShotIds, []);
    await modal().getByRole('button', { name: '完成' }).click();
  });

  await check('覆盖同名目标（R4）：解除数量按顶层并集显示（来源本身未被采用）', async () => {
    await card(G).click({ button: 'right' }); await page.getByRole('menuitem', { name: '标记为废片…' }).click();
    await conflictChoice().selectOption('overwrite'); await modal().getByRole('button', { name: '按所选冲突方式重新核对' }).click();
    await expect(modal()).toContainText('镜 12'); await modal().getByLabel('我已核对上述镜号，确认解除这些采用关系').check();
    await modal().getByRole('button', { name: '移入废片' }).click();
    await expect(modal()).toContainText('已移入废片：1 个视频'); await expect(modal()).toContainText('解除 1 个镜号的采用');
    assert.deepEqual(posts('move-commit').at(-1).body.confirmedUnbindShotIds, ['shot-12']);
    await modal().getByRole('button', { name: '完成' }).click();
  });

  await check('执行回应是 500（R2）：可能已经执行，保持待核对与原编号，只能查询原请求，不给新编号重做', async () => {
    await card(F).click({ button: 'right' }); await page.getByRole('menuitem', { name: '标记为废片…' }).click();
    await expect(modal()).toContainText('将 1 个视频移入废片'); mock.next = '500';
    await modal().getByRole('button', { name: '移入废片' }).click();
    const requestId = posts('move-commit').at(-1).body.requestId;
    await expect(modal()).toContainText('结果待核对'); await expect(modal()).toContainText('（500）'); await expect(modal()).toContainText(requestId);
    await expect(modal().getByRole('button', { name: '重新核对' })).toHaveCount(0);
    await modal().getByRole('button', { name: '查询原请求' }).click(); await expect(modal()).toContainText('已移入废片：1 个视频');
    assert.equal(posts('move-commit').filter(p => p.body.requestId === requestId).length, 1); assert.equal(posts('move-commit').at(-1).body.requestId, requestId);
    await modal().getByRole('button', { name: '完成' }).click(); await expect(card(F)).toHaveCount(0);
  });

  await check('执行被明确拒绝（409）：没有执行，显示原因并可重新核对', async () => {
    await card(B).click({ button: 'right' }); await page.getByRole('menuitem', { name: '标记为废片…' }).click();
    await expect(modal()).toContainText('将 1 个视频移入废片'); mock.next = '409'; const executed = mock.executed.length;
    await modal().getByRole('button', { name: '移入废片' }).click();
    await expect(modal()).toContainText('测试：预览已失效，请重新核对'); await expect(modal().getByRole('button', { name: '重新核对' })).toBeVisible();
    await expect(modal().getByRole('button', { name: '查询原请求' })).toHaveCount(0); assert.equal(mock.executed.length, executed);
    await page.keyboard.press('Escape'); await expect(modal()).toHaveCount(0); await expect(card(B)).toBeVisible();
  });

  const gate = () => { const g = {}; g.arrived = new Promise(r => g.reached = r); g.release = new Promise(r => g.open = r); return g; };
  await check('核对中取消（R3）：移入与收纳处两种核对，取消后旧回应不写入，再打开能正常核对', async () => {
    const g = gate(); mock.holdPreview = g;
    await card(B).click({ button: 'right' }); await page.getByRole('menuitem', { name: '标记为废片…' }).click();
    await g.arrived; await expect(modal()).toContainText('正在核对移入影响'); await page.keyboard.press('Escape'); await expect(modal()).toHaveCount(0);
    g.open(); await page.waitForTimeout(300);
    await card(B).click({ button: 'right' }); await page.getByRole('menuitem', { name: '标记为废片…' }).click();
    await expect(modal()).toContainText('将 1 个视频移入废片'); await page.keyboard.press('Escape');
    const r = gate(); mock.holdRole = r; await chip().click();
    await work().getByRole('button', { name: '更改或取消收纳处…' }).click(); await modal().getByRole('button', { name: '核对影响' }).click();
    await r.arrived; await page.keyboard.press('Escape'); await expect(modal()).toHaveCount(0); r.open(); await page.waitForTimeout(300);
    await work().getByRole('button', { name: '更改或取消收纳处…' }).click(); await expect(modal().getByRole('button', { name: '核对影响' })).toBeEnabled();
    await modal().getByRole('button', { name: '核对影响' }).click(); await expect(modal()).toContainText('核对结果');
    await page.keyboard.press('Escape'); await bar().getByRole('button', { name: '项目根目录' }).click(); await expect(card(B)).toBeVisible();
  });

  await check('废片视图：显示收纳处与数量；“移回…”走普通移动核对，不说会恢复采用', async () => {
    await chip().click(); await expect(work()).toContainText('废片收纳处：废片'); await expect(card(A)).toBeVisible(); await expect(card(C)).toBeVisible();
    if (process.env.PV_SHOTS) await page.screenshot({ path: path.join(process.env.PV_SHOTS, 'reject-view.png') });
    await expect(card(B)).toHaveCount(0);
    await card(A).click(); await detail().getByRole('button', { name: '视频操作' }).click();
    await expect(page.getByRole('menuitem', { name: /标记为废片/ })).toHaveCount(0);
    await page.getByRole('menuitem', { name: /移回/ }).click(); await expect(modal()).toContainText('移动视频');
    await modal().getByRole('button', { name: '核对操作影响' }).click(); await expect(modal()).toContainText('移回项目根目录');
    await modal().getByRole('button', { name: '确认执行' }).click(); await expect(modal()).toContainText('已完成');
    await modal().getByRole('button', { name: '返回列表' }).click(); await expect(card(A)).toHaveCount(0);
    assert.equal(posts('back-preview').at(-1).body.destinationFolderId, 'root');
  });

  await check('取消收纳处：先核对说明“回到普通文件夹、内容不变”，确认后手建文件夹回到文件夹栏', async () => {
    await work().getByRole('button', { name: '更改或取消收纳处…' }).click(); await expect(modal()).toContainText('当前收纳处：废片');
    await modal().getByLabel('取消收纳处（不移动、不删除任何文件）').check(); await modal().getByRole('button', { name: '核对影响' }).click();
    await expect(modal()).toContainText('将取消废片收纳处：“废片”回到普通文件夹，内容保持不变');
    await modal().getByLabel('确认取消废片收纳处').check(); await modal().getByRole('button', { name: '取消收纳处' }).click();
    await expect(modal()).toContainText('已取消废片收纳处'); assert.equal(posts('role-preview').at(-1).body.folderId, null);
    await modal().getByRole('button', { name: '完成' }).click(); await expect(bar().getByRole('button', { name: '废片', exact: true })).toBeVisible();
  });

  await check('新建收纳处：选择新建时预览请求带 create，不自动执行', async () => {
    await bar().getByRole('button', { name: '项目根目录' }).click(); await expect(card(B)).toBeVisible();
    await card(B).click({ button: 'right' }); await page.getByRole('menuitem', { name: '标记为废片…' }).click();
    await modal().getByLabel('在项目根目录新建“废片”文件夹').check(); await modal().getByRole('button', { name: '核对影响' }).click();
    await expect(modal()).toContainText('将在项目根目录新建“废片”文件夹，并设为废片收纳处');
    assert.deepEqual(posts('role-preview').at(-1).body.create, { parentId: 'root', name: '废片' });
    const before = posts('role-commit').length; await page.keyboard.press('Escape'); await expect(modal()).toHaveCount(0); assert.equal(posts('role-commit').length, before);
  });

  await check('收纳处指针失效：显示“需核对”，不按同名目录顶替；标记时先重新设置', async () => {
    mock.role = { revision: mock.role.revision + 1, id: 'missing-folder' };
    await chip().click(); await expect(chip()).toContainText('需核对'); await expect(work()).toContainText('收纳目录需核对');
    await bar().getByRole('button', { name: '项目根目录' }).click(); await expect(card(B)).toBeVisible();
    await card(B).click({ button: 'right' }); await page.getByRole('menuitem', { name: '标记为废片…' }).click();
    await expect(modal()).toContainText('需要核对'); await expect(modal().getByRole('button', { name: '核对影响' })).toBeVisible();
    await page.keyboard.press('Escape');
  });

  assert.deepEqual(errors, [], '页面不应出现脚本错误');
  passed = true;
} finally {
  if (!passed) { console.error(logs.slice(-3000)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'pv-reject-failure.png') }).catch(() => {}); }
  await browser?.close(); child.kill('SIGTERM'); const code = await exited; console.log('app exit:', code);
  await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
