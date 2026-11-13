// 顶栏统一（TOPBAR-UNIFY）：六个页面的顶栏都是同一条层级栏；项目资产页的公共人物库改为页内切换；
// 资产页有未保存修改、或正在处理时，从层级栏切集先经过资产页登记的保护。
// 真实本地服务 + 合成剧集；不接入真实素材库。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { showPublicAssets, projectInBar } from './helpers/path-bar.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-topbar-unify-'));
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const checks = [], errors = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal'), CODEX_HOME: path.join(temp, 'no-codex'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', MEDIA_CODEX_AUTOCONNECT: '0', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body, method) { const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json(); assert.ok(response.ok, p + ' ' + JSON.stringify(data)); return data; }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const rid = () => crypto.randomUUID();
const work = () => page.getByRole('region', { name: '项目资产库' });
// 画廊（未打开详情时）或详情旁的列表（打开详情后）
const list = () => work().locator('section.ca-gallery, [aria-label="当前项目资产列表"]').first();
const cards = () => list().locator('.ca-card:not(.ca-card-add) strong');
const settled = async names => { await expect(list()).toHaveAttribute('aria-busy', 'false'); await expect(cards()).toHaveText(names); };
const nav = name => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true }).click();
const scopeSwitch = () => work().getByRole('group', { name: '看哪里的资产' });
// 本季内选集：点层级栏最后一段（第N集），在本季的集列表里选
async function pickEpisode(id) { await projectInBar(page).getByRole('navigation', { name: '当前项目' }).getByRole('button').last().click(); await projectInBar(page).locator(`.ppb-option[data-target-project="${id}"]`).click(); await expect(projectInBar(page)).toHaveAttribute('data-project', id); }

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  const s = await api('/project-series', { name: '穿越计', software: 'jianying', request_id: rid() });
  const q = await api(`/project-series/${s.id}/seasons`, { request_id: rid() });
  const eps = [];
  for (let i = 1; i <= 3; i++) eps.push(await api(`/project-series/${s.id}/episodes`, { season_id: q.id, expected_episode_no: i, request_id: rid() }));
  const ids = eps.map(e => e.project?.id ?? e.project_id ?? e.id);
  for (const [i, id] of ids.entries()) await api('/project-assets/assets', { project_id: id, kind: 'character', name: `第${i + 1}集人物` });
  const pub = (await api('/project-assets/scopes')).items.find(x => x.project_kind === 'public');
  await api('/project-assets/assets', { project_id: pub.id, kind: 'character', name: '公共人物' });

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => { try { localStorage.setItem('shiguang.refreshSeconds', '0'); } catch {} });
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/#/projects'); await expect(projectInBar(page)).toHaveAttribute('data-project', /./);
  await pickEpisode(ids[1]);

  await check('六个页面顶栏都是同一条层级栏、当前项目一致，旧的「××所属项目」下拉不再出现', async () => {
    for (const name of ['项目', '素材使用', '项目资产', '生成视频', '分镜设计', '提示词模板']) {
      await nav(name);
      const slot = page.locator('.library-topbar .topbar-project-slot');
      await expect(slot.locator('.ppb')).toHaveCount(1);
      await expect(projectInBar(page)).toHaveAttribute('data-project', ids[1]);
      await expect(projectInBar(page).getByRole('navigation', { name: '当前项目' })).toContainText('第2集');
      await expect(page.getByLabel(/^(资产|分镜|图片)所属项目$/)).toHaveCount(0);
    }
  });

  await check('项目资产页跟着层级栏走：下一集直接换到那一集的资产', async () => {
    await nav('项目资产'); await settled(['第2集人物']);
    await page.getByRole('button', { name: '下一集：第3集' }).click();
    await expect(projectInBar(page)).toHaveAttribute('data-project', ids[2]); await settled(['第3集人物']);
    await page.getByRole('button', { name: '上一集：第2集' }).click(); await settled(['第2集人物']);
  });

  await check('公共人物库是页内切换：顶栏不变；在公共库里切顶栏的集，回到那一集的资产', async () => {
    await showPublicAssets(page); await settled(['公共人物']);
    await expect(scopeSwitch().getByRole('button', { name: '公共人物库' })).toHaveAttribute('aria-pressed', 'true');
    await expect(work().getByRole('note')).toContainText('顶栏的当前项目没有变');
    await expect(projectInBar(page)).toHaveAttribute('data-project', ids[1]);
    await expect(work().getByRole('tab', { name: '场景', exact: true })).toBeDisabled();
    await showPublicAssets(page, false); await settled(['第2集人物']);
    await expect(work().getByRole('note')).toHaveCount(0);
    await showPublicAssets(page); await settled(['公共人物']);
    await page.getByRole('button', { name: '下一集：第3集' }).click();
    await expect(projectInBar(page)).toHaveAttribute('data-project', ids[2]); await settled(['第3集人物']);
    await expect(scopeSwitch().getByRole('button', { name: '公共人物库' })).toHaveAttribute('aria-pressed', 'false');
    await page.getByRole('button', { name: '上一集：第2集' }).click(); await settled(['第2集人物']);
  });

  await check('有未保存修改时点「下一集」先确认：取消则顶栏和草稿都不动；确认才换集', async () => {
    await list().locator('.ca-card').filter({ hasText: '第2集人物' }).click();
    const basic = work().getByLabel('基础信息', { exact: true }); await basic.fill('还没保存的草稿');
    const asked = [];
    page.once('dialog', d => { asked.push(d.message()); d.dismiss(); });
    await page.getByRole('button', { name: '下一集：第3集' }).click();
    await expect.poll(() => asked.length).toBe(1);
    await expect(projectInBar(page)).toHaveAttribute('data-project', ids[1]);
    await expect(basic).toHaveValue('还没保存的草稿'); await settled(['第2集人物']);
    // 在别的页面切集也要过同一道保护
    await nav('素材使用');
    page.once('dialog', d => { asked.push(d.message()); d.dismiss(); });
    await page.getByRole('button', { name: '下一集：第3集' }).click();
    await expect.poll(() => asked.length).toBe(2);
    await expect(projectInBar(page)).toHaveAttribute('data-project', ids[1]);
    await nav('项目资产'); await expect(work().getByLabel('基础信息', { exact: true })).toHaveValue('还没保存的草稿');
    page.once('dialog', d => { asked.push(d.message()); d.accept(); });
    await page.getByRole('button', { name: '下一集：第3集' }).click();
    await expect(projectInBar(page)).toHaveAttribute('data-project', ids[2]); await settled(['第3集人物']);
    assert.equal(asked.length, 3, '每次切集只问一次');
    assert.ok(asked.every(m => m.includes('当前修改尚未保存')), asked.join(' | '));
  });

  await check('资产页对话框开着时，程序化切集被保护拦下，不跳错', async () => {
    await work().getByRole('button', { name: /^新建/ }).first().click();
    const dlg = page.getByRole('dialog').filter({ has: page.getByLabel('新资产名称') }); await expect(dlg).toBeVisible();
    // 遮罩挡住鼠标，用程序化点击模拟「绕过遮罩的切换」（例如其他入口调用切项目）
    await projectInBar(page).getByRole('navigation', { name: '当前项目' }).getByRole('button').last().dispatchEvent('click');
    await projectInBar(page).locator(`.ppb-option[data-target-project="${ids[0]}"]`).dispatchEvent('click');
    await page.keyboard.press('Escape').catch(() => {});
    await expect(projectInBar(page)).toHaveAttribute('data-project', ids[2]);
    if (await dlg.count()) await dlg.getByRole('button', { name: /取消|关闭/ }).first().click();
    await expect(dlg).toHaveCount(0); await settled(['第3集人物']);
  });

  assert.deepEqual(errors, [], '页面不应出现脚本错误');
  passed = true;
} finally {
  if (!passed) { console.error(logs.slice(-2000)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'creative-topbar-unify-failure.png') }).catch(() => {}); }
  await browser?.close(); child.kill('SIGTERM'); let timer; if (await Promise.race([exited, new Promise(r => timer = setTimeout(() => r('timeout'), 10000))]) === 'timeout') { child.kill('SIGKILL'); await exited; } clearTimeout(timer);
  await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
