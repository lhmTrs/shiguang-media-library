// 剧本区前端 + 真后端（Codex 的 /api/project-scripts）：新建临时库、合成剧本和合成资料，不接真实素材库、不调模型。
// agent 那一侧（冻结草稿快照、上传泳道图）直接调接口；用户那一侧（定稿、上传/删除资料、看图、试画）走页面。
// 截图写到 SCRIPT_AREA_SHOTS（不设就不截）。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { selectProjectInBar } from './helpers/path-bar.mjs';
import { readFixture } from './fixtures/script-area/make-render-data.mjs';
import { syntheticDocx } from './fixtures/script-area/synthetic-docx.mjs';

const root = path.resolve(import.meta.dirname, '..'), fixtures = path.join(root, 'tests/fixtures/script-area');
const shots = process.env.SCRIPT_AREA_SHOTS || '';
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'script-area-real-ui-'));
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, library, passed = false; const checks = [], errors = [], external = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal_item'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1', MEDIA_CODEX_AUTOCONNECT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body, method) {
  const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'x-shiguang-library-id': library, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json(); assert.ok(response.ok, p + ' ' + response.status + ' ' + JSON.stringify(data)); return data;
}
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const shot = async (name, target = page) => { if (shots) await target.screenshot({ path: path.join(shots, 'real-' + name + '.png'), fullPage: true }); };
const rid = () => crypto.randomUUID();
const area = () => page.getByRole('region', { name: '剧本区' });
const tab = name => area().getByRole('tablist', { name: '剧本区' }).getByRole('tab', { name: new RegExp('^' + name) });
const versions = () => area().getByRole('navigation', { name: '版本' });
const sources = readFixture('fixture_sources');

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token; library = session.instanceId;
  const S = await api('/project-series', { name: '合成剧', software: 'jianying', request_id: rid() });
  const q = await api(`/project-series/${S.id}/seasons`, { request_id: rid() });
  const ep = (await api(`/project-series/${S.id}/episodes`, { season_id: q.id, expected_episode_no: 1, request_id: rid() })).project;
  const P = `/project-scripts/projects/${ep.id}`;
  const saveDraft = async (title, content) => { const now = await api(`/project-assets/projects/${ep.id}/script`); return api(`/project-assets/projects/${ep.id}/script`, { title, content, expected_revision: now.revision }, 'PUT'); };
  const freeze = async () => { const d = await api(P + '/draft'); return (await api(P + '/draft/snapshots', { expected_revision: d.revision, contentDigest: d.contentDigest, requestId: rid() })).snapshot; };
  // agent 那一侧：两份草稿快照（合成 v1、v2 正文）
  await saveDraft('合成剧本', sources['fixture-v1'].text); const snap1 = await freeze();
  await saveDraft('合成剧本', sources['fixture-v2'].text); const snap2 = await freeze();

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { const u = new URL(r.url()); if (u.origin !== origin && !u.protocol.startsWith('data') && !u.protocol.startsWith('blob')) external.push(r.url()); });
  await page.goto(origin + '/#/project-scripts'); await page.reload(); await selectProjectInBar(page, ep.id);
  await expect(area()).toBeVisible();

  await check('真接口：草稿头部写保存时间；第一次定稿是 V1，确认后版本条出现 V1', async () => {
    await expect(area().getByLabel('当前看的是')).toContainText('存过');
    await area().getByRole('button', { name: '定稿', exact: true }).click();
    const dlg = page.getByRole('dialog', { name: '定稿' });
    await expect(dlg.getByRole('heading')).toHaveText('定稿成 V1');
    await expect(dlg.getByLabel('开头几行')).toContainText('2-1 地下 · 夜');
    await dlg.getByRole('button', { name: '确认定稿' }).click();
    await expect(dlg).toHaveCount(0); await expect(area()).toContainText('已定稿成 V1');
    await expect(versions().getByRole('button', { name: 'V1' })).toBeVisible();
    await versions().getByRole('button', { name: 'V1' }).click();
    await expect(area().getByRole('document', { name: '剧本正文（只读）' })).toContainText('小周没拉住老李。');
    await versions().getByRole('button', { name: /^草稿/ }).click();
  });

  await check('真接口：定稿前草稿被别处改过 → 409 提示并重读，换新 requestId 后能定成 V2', async () => {
    await area().getByRole('button', { name: '定稿', exact: true }).click();
    const dlg = page.getByRole('dialog', { name: '定稿' }); await expect(dlg.getByRole('heading')).toHaveText('定稿成 V2');
    await saveDraft('合成剧本', sources['fixture-v2'].text + '别处加的一行。\n');
    await dlg.getByRole('button', { name: '确认定稿' }).click();
    await expect(dlg).toContainText('草稿在你确认前又改过了');
    await expect(dlg.getByLabel('开头几行')).toBeVisible();
    await dlg.getByRole('button', { name: '确认定稿' }).click();
    await expect(dlg).toHaveCount(0);
    await expect(versions().getByRole('button', { name: 'V2' })).toBeVisible();
  });

  let material;
  await check('真接口：甲方资料上传（TXT，挂本集）、带行号预览、勾全局进全局组', async () => {
    await tab('甲方资料').click();
    const mats = area().getByRole('region', { name: '甲方资料' });
    await mats.getByLabel('选择要上传的甲方资料').setInputFiles({ name: '合成文学稿.txt', mimeType: 'text/plain', buffer: Buffer.from(sources['fixture-a'].text, 'utf8') });
    await mats.getByRole('button', { name: '上传', exact: true }).click();
    await expect(mats).toContainText('已上传「合成文学稿.txt」，挂在本集');
    await mats.locator('.sa-material', { hasText: '合成文学稿.txt' }).getByRole('button', { name: '预览' }).click();
    const dlg = page.getByRole('dialog', { name: '预览：合成文学稿.txt' });
    await expect(dlg.locator('.sa-line-no')).toHaveCount(11); await expect(dlg.locator('li').nth(1)).toHaveText('L2 ');
    await dlg.getByRole('button', { name: '关闭' }).click();
    await mats.getByLabel('选择要上传的甲方资料').setInputFiles({ name: '合成人物小传.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%合成\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n') });
    await mats.getByRole('checkbox', { name: /放到全局资料/ }).check();
    await mats.getByRole('button', { name: '上传', exact: true }).click();
    await expect(mats).toContainText('放在全局资料里');
    await expect(mats.locator('.sa-material', { hasText: '合成人物小传.pdf' }).locator('.sa-chip')).toHaveText('全局');
    await mats.getByLabel('选择要上传的甲方资料').setInputFiles({ name: '合成文学稿.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: await syntheticDocx() });
    await mats.getByRole('button', { name: '上传', exact: true }).click();
    await expect(mats).toContainText('已上传「合成文学稿.docx」');
    await mats.locator('.sa-material', { hasText: '合成文学稿.docx' }).getByRole('button', { name: '预览' }).click();
    await expect(page.getByRole('document', { name: 'DOCX 预览：合成文学稿.docx' })).toContainText('合成 DOCX 第一段');
    await page.getByRole('dialog', { name: '预览：合成文学稿.docx' }).getByRole('button', { name: '关闭' }).click();
    material = (await api(P + '/materials')).items.find(m => m.originalFilename === '合成文学稿.txt');
    assert.ok(material.sourceId);
    await shot('materials');
  });

  await check('真接口：试画页用真的 dry-run 画图；反例（差一行）列出问题和实际行号；不保存', async () => {
    const single = readFixture('fixture_single'); single.sources[0].sourceId = material.sourceId;
    const singleFile = path.join(temp, 'single.json'); await fs.writeFile(singleFile, JSON.stringify(single));
    const bad = readFixture('fixture_bad_quote_off_by_one'); for (const s of bad.sources) s.sourceId = s.key === 'V1' ? snap1.sourceId : snap2.sourceId;
    const badFile = path.join(temp, 'bad.json'); await fs.writeFile(badFile, JSON.stringify(bad));
    const before = (await api(P + '/maps')).total;
    const trial = await context.newPage(); trial.on('pageerror', e => errors.push(e.message));
    await trial.goto(origin + `/#/script-map-trial?project=${ep.id}&target=snapshot:${snap2.id}`);
    const rootEl = trial.locator('[data-trial-state]');
    await trial.getByLabel('选择泳道图 JSON').setInputFiles(singleFile);
    await expect(rootEl).toHaveAttribute('data-trial-state', 'ok');
    await expect(trial.locator('.sm-sub')).toContainText('合成文学稿');
    await trial.getByRole('button', { name: '丙：暗门走出质问甲' }).click();
    await expect(trial.getByRole('dialog', { name: '原文' })).toContainText('丙从暗门后走出。\n丙：你以为她会站在你那边？');
    await shot('trial-ok', trial);
    await trial.getByLabel('前稿（改动图才要）').selectOption(`snapshot:${snap1.id}`);
    await trial.getByLabel('选择泳道图 JSON').setInputFiles(badFile);
    await expect(rootEl).toHaveAttribute('data-trial-state', 'invalid');
    await expect(trial.locator('.sm-sheet')).toHaveCount(0);
    await expect(trial.locator('.sa-issue.is-error').first()).toContainText('L9');
    await shot('trial-invalid', trial);
    assert.equal((await api(P + '/maps')).total, before, '试画不保存');
    await trial.close();
  });

  await check('真接口：全新的浏览器（没有 Cookie、没开过主程序）直接打开试画页就能试画', async () => {
    const single = readFixture('fixture_single'); single.sources[0].sourceId = material.sourceId;
    const file = path.join(temp, 'single-fresh.json'); await fs.writeFile(file, JSON.stringify(single));
    const fresh = await browser.newContext(); assert.deepEqual(await fresh.cookies(), []);
    const trial = await fresh.newPage(); trial.on('pageerror', e => errors.push(e.message));
    await trial.goto(origin + `/#/script-map-trial?project=${ep.id}&target=snapshot:${snap2.id}`);
    const rootEl = trial.locator('[data-trial-state]');
    await expect(rootEl).toHaveAttribute('data-trial-state', 'idle');
    await trial.getByLabel('选择泳道图 JSON').setInputFiles(file);
    await expect(rootEl).toHaveAttribute('data-trial-state', 'ok');
    assert.ok((await fresh.cookies()).length > 0, '页面自己拿到了会话 Cookie');
    await fresh.close();
  });

  await check('真接口：agent 传上来的图出现在草稿的泳道图标签；点开整页看图；删掉引用的资料后显示存档摘录', async () => {
    const single = readFixture('fixture_single'); single.sources[0].sourceId = material.sourceId;
    const diff = readFixture('fixture_diff'); for (const s of diff.sources) s.sourceId = s.key === 'V1' ? snap1.sourceId : snap2.sourceId;
    await api(P + '/maps', { binding: { target: { kind: 'snapshot', id: snap2.id } }, graph: single, requestId: rid() });
    await api(P + '/maps', { binding: { before: { kind: 'snapshot', id: snap1.id }, target: { kind: 'snapshot', id: snap2.id } }, graph: diff, requestId: rid() });
    await tab('泳道图').click();
    const cards = area().getByRole('button', { name: /^打开泳道图：/ });
    await expect(cards).toHaveCount(2);
    await expect(cards.filter({ hasText: '合成样例 · 单版' })).toContainText('AI 补了 1 处');
    await expect(cards.filter({ hasText: '改动' })).toContainText('改了 5 处因果或动机，1 处措辞');
    // 草稿在冻结快照之后又改过（409 那一步），草稿图标「基于较早的草稿」
    await expect(cards.first()).toContainText('基于较早的草稿');
    await shot('maps');
    await cards.filter({ hasText: '改动' }).click();
    await expect(area().locator('.sm-sheet svg')).toBeVisible();
    await area().getByRole('button', { name: '小周：没拉住老李' }).click();
    const pop = area().getByRole('dialog', { name: '原文' });
    await expect(pop).toContainText('小周拉住老李。'); await expect(pop).toContainText('小周没拉住老李。');
    await shot('map-diff');
    await page.keyboard.press('Escape');
    await area().getByRole('button', { name: '← 返回泳道图列表' }).click();
    // 删除被引用的资料
    await tab('甲方资料').click();
    const mats = area().getByRole('region', { name: '甲方资料' });
    await mats.locator('.sa-material', { hasText: '合成文学稿.txt' }).getByRole('button', { name: '删除' }).click();
    await page.getByRole('alertdialog', { name: '删除甲方资料' }).getByRole('button', { name: '删除' }).click();
    await expect(mats).toContainText('已删除「合成文学稿.txt」');
    await tab('泳道图').click();
    await area().getByRole('button', { name: /^打开泳道图：/ }).filter({ hasText: '合成样例 · 单版' }).click();
    await area().getByRole('button', { name: '甲：倒地' }).click();
    await expect(area().getByRole('dialog', { name: '原文' })).toContainText('原件已删除，以下为存档摘录');
    await expect(area().getByRole('dialog', { name: '原文' })).toContainText('甲倒地。');
    await shot('map-deleted-source');
  });

  assert.deepEqual(errors, [], '页面没有报错');
  assert.deepEqual(external, [], '没有外部请求');
  passed = true;
} finally {
  await browser?.close();
  child.kill('SIGTERM'); await exited;
  await fs.rm(temp, { recursive: true, force: true });
  console.log((passed ? 'OK ' : 'FAILED ') + checks.length + ' checks');
  if (!passed) { console.log(logs.slice(-3000)); process.exitCode = 1; }
}
