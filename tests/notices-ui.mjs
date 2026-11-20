// 待处理 · 界面测试。先 npm run build；使用系统 Chrome、全新临时库、合成数据。
// 运行：node --test tests/notices-ui.mjs   （NOTICES_SHOTS=<目录> 时把截图存进去）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {chromium} from '@playwright/test';
import {tempDirectories} from './helpers/temp-cleanup.mjs';
import {repo, startServer} from './helpers/project-music-server.mjs';
import {seedPendingRound} from './helpers/notices-fixture.mjs';
import {lowContrast} from './helpers/contrast.mjs';

const makeTemp = tempDirectories(test, 'sg-notices-ui-');
const shots = process.env.NOTICES_SHOTS || null;
const TEXT = '.sg-notices h2, .sg-notices h3, .sg-notices h4, .sg-notices p, .sg-notices button, .sg-notices span, .sg-notices time, .sg-notices strong';

test('待处理：顶栏 N、四组抽屉、重做先确认花费、稍后不计数、已读、又失败开新卡、跳到相关页面、深色和三套配色可读、窄窗口', async t => {
  await fs.access(path.join(repo, 'dist', 'index.html')).catch(() => assert.fail('请先 npm run build'));
  if (shots) await fs.mkdir(shots, {recursive: true});
  const base = await makeTemp(t);
  const seed = await seedPendingRound(base);
  const s = await startServer(t, base);
  const day = 86_400_000;
  const post = async body => { const r = await s.call('POST', '/notices', {source: 'synthetic-runner', session: '合成跟进器', ...body}); assert.equal(r.status, 201, r.text); return r.body.notice; };
  const A = await post({key: 'job-a', kind: 'decision', typeLabel: '生成失败 · 超时', title: '合成短剧 · 56 集 · S2 镜', context: '合成：平台返回任务执行超时',
    costNote: '重做约花 1 次生成费', owner: {session: '合成导演会话', id: 'local_synthetic'}, links: [{label: '看这首歌', view: 'projectMusic', projectId: seed.projectId}], occurredAt: Date.now() - 3 * day});
  const B = await post({key: 'job-b', kind: 'decision', typeLabel: '生成失败 · 参考图尺寸', title: '合成短剧 · 56 集 · S5 镜',
    costNote: '重做约花 1 次生成费', owner: {session: '已经不在的会话', gone: true}, occurredAt: Date.now() - 2 * day});

  const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, timeout: 30000});
  t.after(() => browser.close());
  const context = await browser.newContext({viewport: {width: 1360, height: 900}});
  context.setDefaultTimeout(20000);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(s.origin + '/#/materials');

  // 顶栏入口：N 只算要你拍板、还没处理的（2 张），只是告知的不算
  const entry = page.locator('.sgn-entry');
  await entry.locator('.sgn-count', {hasText: '2'}).waitFor();
  assert.equal(await entry.getAttribute('aria-label'), '待处理，2 件要你拍板');
  await entry.click();
  const drawer = page.locator('aside.sg-notices');
  await drawer.waitFor();
  const group = name => drawer.locator('section.sgn-group', {has: page.getByRole('heading', {name: new RegExp('^' + name)})});
  await group('要你拍板').locator('.sgn-card').nth(1).waitFor();
  assert.equal(await group('要你拍板').locator('.sgn-card').count(), 2);
  assert.equal(await group('只是告知').locator('.sgn-card').count(), 1);

  // 卡片内容：类型、标题、来源和负责、发生时间和挂了几天、花费、链接
  const cardA = drawer.locator(`[data-notice-id="${A.id}"]`);
  const textA = await cardA.innerText();
  for (const want of ['生成失败 · 超时', '合成短剧 · 56 集 · S2 镜', 'synthetic-runner', '负责：合成导演会话', '已挂 3 天', '重做约花 1 次生成费', '看这首歌', '重做…', '知道了，不重做', '稍后'])
    assert.ok(textA.includes(want), `卡片缺「${want}」：${textA}`);
  assert.match(textA, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  const cardB = drawer.locator(`[data-notice-id="${B.id}"]`);
  await cardB.getByText('待分派').waitFor();
  const info = group('只是告知').locator('.sgn-card');
  assert.match(await info.innerText(), /待 AI 补写[\s\S]*合成项目 · 合成歌曲 · 第 1 轮[\s\S]*项目音乐[\s\S]*已读/);
  if (shots) await page.screenshot({path: path.join(shots, 'notices-follow.png')});

  // 稍后：进「稍后」组，N 减 1，不提供「稍后」按钮了
  await cardB.getByRole('button', {name: '稍后'}).click();
  await group('稍后').locator(`[data-notice-id="${B.id}"]`).waitFor();
  await entry.locator('.sgn-count', {hasText: '1'}).waitFor();
  assert.equal(await group('稍后').getByRole('button', {name: '稍后'}).count(), 0);
  await group('稍后').getByText('不会自动提醒').waitFor();

  // 重做…：先弹确认框写清花费；取消什么都不变
  await cardA.getByRole('button', {name: '重做…'}).click();
  const dialog = page.getByRole('dialog', {name: '确定重做？'});
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /花费[\s\S]*重做约花 1 次生成费[\s\S]*拾光不会自己去执行[\s\S]*合成导演会话/);
  if (shots) await page.screenshot({path: path.join(shots, 'notices-redo-confirm.png')});
  await dialog.getByRole('button', {name: '取消'}).click();
  await dialog.waitFor({state: 'detached'});
  assert.equal((await s.call('GET', `/notices/${A.id}`)).body.notice.status, 'open');
  await cardA.getByRole('button', {name: '重做…'}).click();
  await dialog.getByRole('button', {name: '确定重做'}).click();
  await dialog.waitFor({state: 'detached'});
  await group('要你拍板').getByRole('heading', {name: /已决定，等执行/}).waitFor();
  await cardA.getByText('已决定重做 · 等执行').waitFor();
  assert.equal(await cardA.getByRole('button').filter({hasText: /重做|不重做|稍后/}).count(), 0, '决定之后不再显示决定按钮');
  await page.waitForFunction(() => !document.querySelector('.sgn-entry .sgn-count'));
  const decided = (await s.call('GET', `/notices/${A.id}`)).body.notice;
  assert.deepEqual([decided.status, decided.decision.action, decided.decision.by], ['redo_decided', 'redo', 'user']);

  // 执行方报「又失败」：原卡进「已结束」，另开一张新卡等你拍板
  const failed = await s.call('POST', `/notices/${A.id}/result`, {state: 'failed', session: '合成跟进器', note: '合成：又超时了'});
  assert.equal(failed.status, 200, failed.text);
  await entry.click(); await entry.click(); // 关掉再打开：立即刷新
  const fresh = drawer.locator(`[data-notice-id="${failed.body.next.id}"]`);
  await fresh.waitFor();
  assert.match(await fresh.innerText(), /重做后又失败[\s\S]*合成短剧 · 56 集 · S2 镜[\s\S]*合成：又超时了/);
  await entry.locator('.sgn-count', {hasText: '1'}).waitFor();
  const ended = drawer.locator('details.sgn-ended');
  assert.equal(await ended.getAttribute('open'), null, '已结束默认折叠');
  await ended.locator('summary').click();
  await ended.locator(`[data-notice-id="${A.id}"]`).getByText('又失败').waitFor();
  await ended.getByText('已经另开了一张新卡').waitFor();

  // 链接：跳到项目音乐，抽屉关上
  await info.getByRole('button', {name: '看这首歌'}).click();
  await drawer.waitFor({state: 'detached'});
  await page.waitForFunction(() => location.hash === '#/project-music');
  await page.locator('section.sg-music').getByRole('heading', {name: '合成歌曲'}).waitFor();

  // 已读：只是告知的卡结束
  await entry.click();
  await group('只是告知').getByRole('button', {name: '已读'}).click();
  await page.waitForFunction(() => !document.querySelector('#notices-drawer h3#sgn-g-info'));
  assert.equal((await s.call('GET', '/notices?source=project-music')).body.notices[0].status, 'read');
  await drawer.locator('details.sgn-ended summary').click();

  // 对比度：跟随主题（浅色、深色）和三套试用配色
  const check = async label => {
    await drawer.locator('.sgn-card').first().waitFor();
    const det = drawer.locator('details.sgn-ended');
    if (await det.getAttribute('open') === null) await det.locator('summary').click();
    const bad = await lowContrast(page, TEXT + ', .sgn-entry span, .sgn-entry b', 4.5);
    assert.deepEqual(bad, [], `${label} 有看不清的文字`);
  };
  await check('浅色跟随主题');
  for (const [theme, palette] of [['dark', 'follow'], ['forest', 'paper'], ['forest', 'studio'], ['forest', 'gallery']]) {
    await page.evaluate(([th, p]) => { localStorage.setItem('shiguang.theme', th); localStorage.setItem('shiguang.musicPalette.v1', p); }, [theme, palette]);
    await page.reload();
    await entry.click();
    await check(`${theme}/${palette}`);
    assert.equal(await drawer.getAttribute('data-sg-palette'), palette);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme || 'forest'), theme);
    if (shots) await page.screenshot({path: path.join(shots, `notices-${palette === 'follow' ? 'dark' : palette}.png`)});
  }

  // 窄窗口：抽屉占满宽度，不横向溢出，按钮都看得见
  await page.evaluate(() => { localStorage.setItem('shiguang.theme', 'forest'); localStorage.setItem('shiguang.musicPalette.v1', 'paper'); });
  await page.setViewportSize({width: 390, height: 844});
  await page.reload();
  await entry.click();
  await drawer.locator('.sgn-card').first().waitFor();
  const box = await drawer.boundingBox();
  assert.ok(box && Math.abs(box.width - 390) <= 1, `窄窗口抽屉宽 ${box?.width}`);
  const overflow = await drawer.locator('.sgn-body').evaluate(el => el.scrollWidth - el.clientWidth);
  assert.ok(overflow <= 1, `窄窗口横向溢出 ${overflow}px`);
  for (const b of await drawer.locator('.sgn-actions button').all()) {
    const r = await b.boundingBox();
    assert.ok(r && r.x >= 0 && r.x + r.width <= 391, '按钮被挤出画面');
  }
  await check('窄窗口纸张');
  if (shots) await page.screenshot({path: path.join(shots, 'notices-narrow-paper.png')});
  // Esc 关闭，焦点回到入口
  await page.keyboard.press('Escape');
  await drawer.waitFor({state: 'detached'});
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('sgn-entry')), true);
  assert.deepEqual(errors, []);
});
