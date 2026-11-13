// 人物属性维度剧内统一（合同 v1 · A）前后端组合：真实本地服务，不替身任何接口。
// 旧剧夹具按 Codex 的做法：建剧后删掉 series_attribute_alignment 标记（只在本测试的临时库里）。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { chromium, expect } from '@playwright/test';
import { selectProjectInBar } from './helpers/path-bar.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'series-attr-align-real-'));
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const checks = [], errors = [], failures = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal'), CODEX_HOME: path.join(temp, 'no-codex'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', MEDIA_CODEX_AUTOCONNECT: '0', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body, method) { const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json(); if (!response.ok) throw Object.assign(Error(data.error || response.status), { data }); return data; }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const rid = () => crypto.randomUUID();
const nav = name => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true }).click();
const work = () => page.getByRole('region', { name: '项目资产库' });
const pf = () => page.locator('.pf');
const scopeSwitch = () => work().getByRole('group', { name: '看哪里的资产' });
const toRoot = async () => { await pf().waitFor(); const up = pf().getByRole('navigation', { name: '位置' }).getByRole('button', { name: '项目' }); if (await up.count()) await up.click(); };
const config = id => api('/project-assets/projects/' + encodeURIComponent(id) + '/attribute-config');

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  const S = await api('/project-series', { name: '穿越计', software: 'jianying', request_id: rid() });
  const q = await api(`/project-series/${S.id}/seasons`, { request_id: rid() });
  const eps = []; for (let i = 1; i <= 2; i++) eps.push((await api(`/project-series/${S.id}/episodes`, { season_id: q.id, expected_episode_no: i, request_id: rid() })).project);
  // 旧剧：删掉对齐标记，各集回到各自的维度（只动本测试的临时库）
  const db = new Database(path.join(temp, 'data', 'library.sqlite')); db.prepare('DELETE FROM series_attribute_alignment WHERE id=?').run(S.id); db.close();
  // 第 2 集多一个全剧没有的维度，统一时要逐项决定
  const c2 = await config(eps[1].id);
  await api('/project-assets/projects/' + eps[1].id + '/attribute-config', { expected_revision: c2.revision, config_token: c2.config_token,
    dimensions: [...c2.dimensions, { id: null, name: '名望', negative_label: '无名', neutral_label: '小有名气', positive_label: '显赫', criterion: '合成依据' }] }, 'PUT');
  await api('/project-assets/assets', { project_id: eps[0].id, kind: 'character', name: '卖油郎' });
  const solo = await api('/projects', { name: '独立短片' });
  const fresh = []; for (const n of ['新剧_1', '新剧_2']) fresh.push(await api('/projects', { name: n }));
  // 新剧_1 独有「胆识」，用来区分「复制新剧_1」和「系统默认」两种基准
  const f1 = await config(fresh[0].id);
  await api('/project-assets/projects/' + fresh[0].id + '/attribute-config', { expected_revision: f1.revision, config_token: f1.config_token,
    dimensions: [...f1.dimensions, { id: null, name: '胆识', negative_label: '怯懦', neutral_label: '寻常', positive_label: '果敢', criterion: '合成依据' }] }, 'PUT');
  assert.equal((await config(eps[0].id)).alignment_status, 'pending', '夹具应是待统一的旧剧');

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => { try { localStorage.setItem('shiguang.refreshSeconds', '0'); } catch {} });
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  page.on('response', r => { const p = new URL(r.url()).pathname; if (/attribute|project-series/.test(p) && r.status() >= 500) failures.push(r.status() + ' ' + p); });
  await page.goto(origin + '/#/all'); await expect(page.locator('.ppb').first()).toHaveAttribute('data-project', /./);
  await selectProjectInBar(page, eps[0].id); await nav('项目资产');

  await check('A2 真实：旧剧提示还没统一；第 2 集多出的「名望」默认保留为旧评分；确认后两集都改用全剧维度', async () => {
    await scopeSwitch().getByRole('button', { name: '全剧', exact: true }).click();
    await work().locator('.aa-banner').getByRole('button', { name: '查看并统一' }).click();
    const dlg = page.getByRole('dialog', { name: '统一「穿越计」的人物属性维度' });
    await expect(dlg).toContainText('需要你决定'); await expect(dlg).toContainText('名望');
    await expect(dlg.getByRole('radio', { name: /保留为旧评分/ })).toBeChecked();
    await dlg.getByRole('button', { name: '确认统一' }).click(); await expect(dlg).toHaveCount(0);
    await expect(work().locator('.aa-banner')).toHaveCount(0); await expect(work()).toContainText('已统一');
    for (const e of eps) { const c = await config(e.id); assert.equal(c.config_scope, 'series'); assert.equal(c.alignment_status, 'aligned'); }
    assert.ok(!(await config(eps[1].id)).dimensions.some(d => d.name === '名望'), '选了保留为旧评分，全剧不应新增名望');
  });

  await check('A1 真实：集里属性区说明由全剧统一；集里打分（带真实配置凭证）保存成功；「去全剧设置」打开全剧维度', async () => {
    await scopeSwitch().getByRole('button').first().click();
    await work().locator('.ca-card').filter({ hasText: '卖油郎' }).first().click(); await expect(work().locator('.ca-name-input')).toHaveValue('卖油郎');
    const attrs = work().getByRole('region', { name: '人物属性' }); await expect(attrs).toContainText('这一集的维度由全剧统一设置');
    await attrs.getByRole('button', { name: '编辑' }).click(); await attrs.locator('input[type=number]').first().fill('15');
    await attrs.getByRole('button', { name: '保存属性' }).click(); await expect(attrs.getByRole('button', { name: '编辑' })).toBeVisible();
    await attrs.getByRole('button', { name: '维度在全剧设置…' }).click();
    await page.getByRole('dialog', { name: '人物属性维度' }).getByRole('button', { name: '去全剧设置' }).click();
    await expect(scopeSwitch().getByRole('button', { name: '全剧', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const d = page.getByRole('dialog', { name: '人物属性维度' }); await expect(d).toContainText('全剧「穿越计」'); await d.getByRole('button', { name: '关闭维度设置' }).click();
  });

  await check('A3 真实：把独立项目放进已统一的剧（维度一致不用决定）直接移动；提示改用这部剧的维度且没有撤销', async () => {
    await nav('项目'); await toRoot();
    await pf().getByRole('button', { name: /^独立短片/ }).first().click({ button: 'right' }); await page.getByRole('menuitem', { name: '放进剧…' }).click();
    await page.getByRole('dialog', { name: '移到…' }).getByRole('button', { name: '移动' }).click();
    await page.getByRole('dialog').filter({ has: page.getByRole('button', { name: '保存' }) }).getByRole('button', { name: '保存' }).click();
    const map = page.getByRole('dialog', { name: /放进「穿越计」/ });
    if (await map.count()) await map.getByRole('button', { name: '确认放进剧' }).click(); // 后端判定需要核对时走对应窗口
    const toast = pf().locator('.pf-toast'); await expect(toast).toContainText('人物属性维度已改用这部剧的'); await expect(toast.getByRole('button', { name: '撤销' })).toHaveCount(0);
    assert.equal((await config(solo.id)).config_scope, 'series');
  });

  await check('A3 真实：把一集移出剧，复制一份全剧维度作为它自己的', async () => {
    await toRoot(); await pf().getByRole('button', { name: '打开剧 穿越计' }).click(); await pf().getByRole('button', { name: /^打开 第 1 季/ }).click();
    await pf().getByRole('button', { name: /第 2 集/ }).first().click({ button: 'right' }); await page.getByRole('menuitem', { name: '移到…' }).click();
    const d = page.getByRole('dialog', { name: '移到…' }); await d.getByLabel('目标位置').selectOption('out'); await d.getByRole('button', { name: '移动' }).click();
    const map = page.getByRole('dialog', { name: /移出剧/ }); if (await map.count()) await map.getByRole('button', { name: '确认移出' }).click();
    await expect(pf().locator('.pf-toast')).toContainText('移出剧');
    const c = await config(eps[1].id); assert.equal(c.config_scope, 'project'); assert.equal(c.alignment_status, 'standalone');
  });

  await check('A3 真实：整理旧项目新建剧，选「复制某一集的维度」作基准后归组', async () => {
    await toRoot(); await pf().getByRole('button', { name: '整理旧项目' }).click();
    const dlg = page.getByRole('dialog', { name: '整理旧项目' }); await dlg.getByRole('button', { name: /^归组 \d+ 个项目/ }).click();
    const base = dlg.getByLabel('新剧的维度基准'); await expect(base).toBeVisible(); // 两个基准可选，必须先核对
    await base.selectOption({ label: '复制「新剧_1」的维度' });
    await expect(base.locator('option:checked')).toHaveText('复制「新剧_1」的维度'); // 重新预览后服务端回显仍是这个选择
    const go = dlg.getByRole('button', { name: /^归组 \d+ 个项目/ }); await expect(go).toBeEnabled(); await go.click();
    await expect(dlg).toHaveCount(0);
    for (const f of fresh) { const c = await config(f.id); assert.equal(c.config_scope, 'series'); assert.ok(c.dimensions.some(d => d.name === '胆识'), '基准复制自新剧_1，全剧维度应带「胆识」'); }
  });

  assert.deepEqual(failures, [], '不应有服务端 5xx');
  assert.deepEqual(errors, [], '页面不应出现脚本错误');
  passed = true;
} finally {
  if (!passed) { console.error(logs.slice(-2500)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'series-attr-align-real-failure.png') }).catch(() => {}); }
  await browser?.close(); child.kill('SIGTERM'); let timer; if (await Promise.race([exited, new Promise(r => timer = setTimeout(() => r('timeout'), 10000))]) === 'timeout') { child.kill('SIGKILL'); await exited; } clearTimeout(timer);
  await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
