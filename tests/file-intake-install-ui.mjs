// 访达入口安装反馈（INSTALL-FEEDBACK）：按钮正下方的进行中 / 慢 / 疑似卡住 / 成功 / 失败，
// 顶栏入口的安装标记，刷新后从状态接口恢复，打开系统设置的结果。
// 只用合成接口：不调用真实 swiftc，不写系统服务目录，不打开系统设置。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium, expect} from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'file-intake-install-ui-')));
const evidence = path.resolve(process.env.FILE_INTAKE_INSTALL_EVIDENCE || path.join(temp, 'evidence')); await fs.mkdir(evidence, {recursive: true});
const checks = [], posts = [], errors = []; let server, browser, page, origin, passed = false;
const fixture = {status: null, settings: 'ok', next: null, sequence: 0};
function fresh() {
  fixture.status = {supported: true, installed: true, upgradeNeeded: false, canTrash: true, activeCount: 0, needsAttention: 0, latestCompletion: null, installJob: null};
  fixture.settings = 'ok'; fixture.next = null; posts.length = 0;
}
/** 新建一个安装任务；next 决定它的初始形态（默认立即完成）。 */
function startJob() {
  const at = Date.now(), id = 'job-' + (++fixture.sequence);
  const base = {id, stage: 'done', window: 'skipped', startedAt: at, finishedAt: at, message: '右键入口已安装。首次请在系统设置 → 键盘 → 键盘快捷键 → 服务，启用“收纳素材到拾光”。', error: null, previousKept: null};
  fixture.status.installJob = {...base, ...(fixture.next || {})};
  if (fixture.status.installJob.stage === 'done') fixture.status.installed = true;
  return fixture.status.installJob;
}
async function routeApi(route) {
  const req = route.request(), url = new URL(req.url()), method = req.method(), endpoint = url.pathname.replace('/api/file-intake', '');
  const respond = (value, status = 200) => route.fulfill({status, json: structuredClone(value)});
  if (method === 'POST') posts.push(endpoint);
  if (endpoint === '/status') return respond(fixture.status);
  if (endpoint === '/batches') return respond({batches: []});
  if (endpoint === '/install/job') {
    if (method === 'GET') return respond({job: fixture.status.installJob});
    const job = fixture.status.installJob && !['done', 'failed'].includes(fixture.status.installJob.stage) ? fixture.status.installJob : startJob();
    return respond({job}, 202);
  }
  if (endpoint === '/open-services-settings') return fixture.settings === 'ok' ? respond({opened: true, target: 'keyboard'}) : respond({code: 'SETTINGS_OPEN_FAILED', error: '合成：系统设置拒绝打开'}, 500);
  return respond({error: 'Unexpected synthetic endpoint ' + endpoint}, 404);
}
const drawer = () => page.getByRole('dialog', {name: '文件任务'});
const entry = () => page.getByRole('button', {name: /^文件任务/});
const install = () => drawer().locator('.fi-install');
const installButton = () => install().locator(':scope > button');
const state = () => install().locator('.fi-install-state');
async function open() { if (!await drawer().count()) await entry().click(); await expect(drawer()).toBeVisible(); }
async function close() { if (await drawer().count()) await drawer().getByRole('button', {name: '关闭文件任务', exact: true}).click(); await expect(drawer()).toHaveCount(0); }
async function reload() { await page.reload(); await expect(entry()).toBeVisible(); }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }

try {
  await fs.writeFile(path.join(temp, 'index.html'), '<html><div id="root"></div><script type="module" src="/fixture.tsx"></script></html>');
  await fs.writeFile(path.join(temp, 'fixture.tsx'), `import React from 'react';import{createRoot}from'react-dom/client';import{FileTaskEntry}from${JSON.stringify(path.join(root, 'src/file-intake/index.ts'))};import{GlobalFeedback}from${JSON.stringify(path.join(root, 'src/global-feedback.tsx'))};
import ${JSON.stringify(path.join(root, 'src/style.css'))};import ${JSON.stringify(path.join(root, 'src/themes.css'))};import ${JSON.stringify(path.join(root, 'src/library-workspace.css'))};
const request=async(url,body,method,options)=>{const response=await fetch('/api'+url,{method:method||(body===undefined?'GET':'POST'),headers:{'content-type':'application/json','x-local-token':'synthetic-token'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:options?.signal});const value=await response.json();if(!response.ok)throw Object.assign(Error(value.error),{...value,status:response.status});return value;};
createRoot(document.getElementById('root')).render(<><div className="app library-workspace"><main><header className="topbar library-topbar"><div className="breadcrumb">合成页面</div><div className="topbar-actions"><FileTaskEntry request={request} onView={()=>{}}/></div></header></main></div><GlobalFeedback/></>);`);
  server = await createServer({configFile: false, root: temp, envDir: temp, cacheDir: path.join(temp, '.vite'), esbuild: {jsx: 'automatic'}, resolve: {alias: {react: path.join(root, 'node_modules/react'), 'react-dom': path.join(root, 'node_modules/react-dom'), 'lucide-react': path.join(root, 'node_modules/lucide-react')}}, server: {host: '127.0.0.1', port: 0, hmr: false, fs: {allow: [root, temp]}}, logLevel: 'error'});
  await server.listen(); origin = server.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const context = await browser.newContext({viewport: {width: 1280, height: 860}});
  await context.route(origin + '/api/**', routeApi);
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  fresh(); await page.goto(origin + '/'); await expect(entry()).toBeVisible();

  await check('快速安装：反馈在按钮正下方，成功写明还差一步；打开系统设置的成功与失败都在原处说明', async () => {
    fresh(); await reload(); await open();
    await installButton().click();
    await expect(state()).toContainText('已安装 · 刚刚'); await expect(state()).toContainText('启用“收纳素材到拾光”');
    await expect(installButton()).toHaveText('重新安装访达入口'); await expect(installButton()).toBeEnabled();
    // 抽屉顶部不再出现安装进度那一行
    await expect(drawer().locator('.fi-drawer-body > p[role=status]')).toHaveCount(0);
    assert.deepEqual(posts, ['/install/job']);
    await state().getByRole('button', {name: '打开系统设置'}).click();
    await expect(state()).toContainText('已打开系统设置的「键盘」'); await expect(state()).toContainText('「键盘快捷键…」→「服务」');
    fixture.settings = 'error'; await state().getByRole('button', {name: '打开系统设置'}).click();
    await expect(state().getByRole('alert')).toContainText(/没有打开系统设置：.*合成：系统设置拒绝打开/);
    await page.screenshot({path: path.join(evidence, 'install-done.png')});
  });

  await check('慢安装：3 秒后展开真实阶段和已用时间；进行中不能再点；关抽屉后顶栏转圈，结束变 ✓，打开抽屉后收起', async () => {
    fresh(); await reload(); await open();
    fixture.next = {stage: 'checking', window: null, finishedAt: null, message: null};
    await installButton().click();
    await expect(installButton()).toBeDisabled(); await expect(installButton()).toHaveText('正在安装…'); await expect(installButton()).toHaveAttribute('aria-busy', 'true');
    await expect(state()).toHaveText('正在安装访达入口');
    const job = fixture.status.installJob; Object.assign(job, {stage: 'preparing-window', window: 'compiling', startedAt: Date.now() - 5000});
    await expect(state()).toContainText(/正在安装 · 已用 \d+ 秒/);
    const steps = state().locator('.fi-install-steps li');
    await expect(steps.nth(0)).toHaveAttribute('data-state', 'done'); await expect(steps.nth(1)).toHaveAttribute('data-state', 'active');
    await expect(steps.nth(1)).toContainText('本机编译，首次约 1–2 分钟'); await expect(steps.nth(2)).toHaveAttribute('data-state', 'todo');
    await expect(state()).toContainText('可以关闭抽屉，安装会在后台继续');
    await page.screenshot({path: path.join(evidence, 'install-slow.png')});
    await installButton().click({force: true}).catch(() => {}); assert.deepEqual(posts, ['/install/job'], '进行中不会再开第二次安装');
    await close(); await expect(entry().getByRole('img', {name: '访达入口安装中'})).toBeVisible();
    Object.assign(job, {stage: 'writing'}); await page.waitForTimeout(1200); Object.assign(job, {stage: 'done', finishedAt: Date.now(), message: '右键入口已安装。合成完成说明。'});
    await expect(entry().getByRole('img', {name: '访达入口已安装，未查看'})).toBeVisible({timeout: 8000});
    await open(); await expect(state()).toContainText('已安装'); await expect(state()).toContainText('合成完成说明');
    await close(); await expect(entry().locator('.fi-install-chip')).toHaveCount(0);
  });

  await check('超过 2 分钟仍在安装：提示可能卡在编译器，仍不开放重试', async () => {
    fresh(); fixture.status.installJob = {id: 'job-stuck', stage: 'preparing-window', window: 'compiling', startedAt: Date.now() - 125000, finishedAt: null, message: null, error: null, previousKept: null};
    await reload(); await expect(entry().getByRole('img', {name: '访达入口安装中'})).toBeVisible(); await open();
    await expect(state()).toContainText('已超过 2 分钟仍未完成，可能卡在系统编译器'); await expect(state()).toContainText(/已用 2 分 \d+ 秒/);
    await expect(installButton()).toBeDisabled(); assert.deepEqual(posts, []);
  });

  await check('刷新页面后从状态接口恢复进行中的安装和当前阶段', async () => {
    fresh(); fixture.status.installJob = {id: 'job-refresh', stage: 'writing', window: 'skipped', startedAt: Date.now() - 8000, finishedAt: null, message: null, error: null, previousKept: null};
    await reload(); await open();
    await expect(installButton()).toHaveText('正在安装…');
    const steps = state().locator('.fi-install-steps li');
    await expect(steps.nth(1)).toContainText('已有，跳过'); await expect(steps.nth(2)).toHaveAttribute('data-state', 'active');
    assert.deepEqual(posts, [], '刷新恢复只读状态，不重新发起安装');
  });

  await check('失败：在按钮下方说明原因；核实旧入口仍在时说明可继续使用；按钮变「重试安装」并可重试', async () => {
    fresh(); fixture.next = {stage: 'failed', window: 'compiling', finishedAt: Date.now(), message: null, error: {code: 'INTAKE_COMPILER_TIMEOUT', message: '合成：准备窗口组件超时，未安装右键入口'}, previousKept: true};
    await reload(); await open(); await installButton().click();
    await expect(state().getByRole('alert').or(state())).toContainText('安装没有完成');
    await expect(state()).toContainText('合成：准备窗口组件超时'); await expect(state()).toContainText('原来的右键入口保持不变');
    await expect(installButton()).toHaveText('重试安装'); await expect(installButton()).toBeEnabled();
    await page.screenshot({path: path.join(evidence, 'install-failed.png')});
    fixture.next = null; await installButton().click(); await expect(state()).toContainText('已安装 · 刚刚');
    assert.deepEqual(posts, ['/install/job', '/install/job']);
  });

  await check('旧入口未核实时不承诺可用；服务中断的上次安装单独说明；很久以前的成功不再显示', async () => {
    fresh(); fixture.status.installJob = {id: 'job-rollback', stage: 'failed', window: 'skipped', startedAt: Date.now() - 60000, finishedAt: Date.now() - 50000, message: null, error: {code: 'INTAKE_INSTALL_ROLLBACK_FAILED', message: '合成：旧入口备份已保留，请核对后再试'}, previousKept: false};
    await reload(); await open(); await expect(state()).toContainText('合成：旧入口备份已保留'); await expect(state()).not.toContainText('原来的右键入口保持不变');
    fresh(); fixture.status.installJob = {id: 'job-interrupted', stage: 'failed', window: null, startedAt: Date.now() - 600000, finishedAt: Date.now() - 300000, message: null, error: {code: 'INSTALL_INTERRUPTED', message: '服务重启，上次安装未完成'}, previousKept: null};
    await reload(); await open(); await expect(state()).toContainText('上次安装被中断 · 5 分钟前');
    fresh(); fixture.status.installJob = {id: 'job-old', stage: 'done', window: 'skipped', startedAt: Date.now() - 3600000, finishedAt: Date.now() - 3600000, message: '早先安装', error: null, previousKept: null};
    await reload(); await open(); await expect(state()).toHaveCount(0); await expect(installButton()).toHaveText('重新安装访达入口');
    await expect(entry().locator('.fi-install-chip')).toHaveCount(0);
  });

  await check('窄屏与深色主题：安装状态不溢出', async () => {
    fresh(); fixture.status.installJob = {id: 'job-narrow', stage: 'preparing-window', window: 'compiling', startedAt: Date.now() - 9000, finishedAt: null, message: null, error: null, previousKept: null};
    await page.setViewportSize({width: 390, height: 844}); await reload(); await page.evaluate(() => document.documentElement.dataset.theme = 'midnight'); await open();
    await install().scrollIntoViewIfNeeded(); await expect(state()).toContainText('准备窗口组件');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '页面不应横向溢出');
    const box = await state().boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 391, JSON.stringify(box));
    await page.screenshot({path: path.join(evidence, 'install-narrow-dark.png')});
  });

  assert.deepEqual(errors, [], '页面不应有脚本错误');
  passed = true;
} catch (e) {
  console.error(e); if (page) await page.screenshot({path: path.join(evidence, 'failure.png')}).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close(); await server?.close(); if (passed || process.env.FILE_INTAKE_INSTALL_EVIDENCE) await fs.rm(temp, {recursive: true, force: true}); else console.error('测试证据保留在：' + evidence);
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
