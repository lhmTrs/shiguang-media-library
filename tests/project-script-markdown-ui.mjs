// 项目剧本正文的 Markdown 阅读 / 编辑切换。真实本地服务 + 合成剧本；不接入真实素材库，不调用模型。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { selectProjectInBar } from './helpers/path-bar.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-script-md-'));
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const checks = [], errors = [], external = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal_item'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body, method) { const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json(); assert.ok(response.ok, p + ' ' + JSON.stringify(data)); return data; }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const work = () => page.getByRole('region', { name: '项目资产库' });
const script = () => work().getByRole('region', { name: '项目剧本' });
const reader = () => script().getByRole('document', { name: '剧本正文（阅读）' });
const body = () => script().getByLabel('剧本正文', { exact: true });
const viewBtn = name => script().getByRole('group', { name: '正文显示方式' }).getByRole('button', { name });
const outline = () => script().getByRole('navigation', { name: '场次大纲' }).getByRole('button');

const markdown = [
  '## 场一｜内景｜地下管渠·第三段｜日',
  '李四、工头、工友',
  '',
  '接第53集尾帧：油灯旁，细沙落成一线。',
  '',
  '> 【字幕】半月后。',
  '',
  '**工头**：李四，车怎么停了？',
  '**李四**：墙那边漏沙。*水里也都是。*',
  '',
  '- 运料车',
  '- 木柱',
  '',
  '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>[外链](https://example.com/a.png) ![图](https://example.com/b.png)',
  '',
  '---',
  '',
  '1. 场二｜外景｜竖井口｜当日稍晚',
  '工头站在竖井口。',
  ...Array.from({ length: 60 }, (_, i) => '填充行 ' + (i + 1)),
  '',
  '## 场三｜外景｜竖井口｜次日',
  '李四回到竖井口。',
].join('\n');

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  const project = await api('/projects', { name: '剧本排版短片' });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { const u = new URL(r.url()); if (u.origin !== origin && !u.protocol.startsWith('data') && !u.protocol.startsWith('blob')) external.push(r.url()); });
  const open = async () => { await page.goto(origin + '/#/project-assets'); await page.reload(); await expect(work()).toBeVisible(); await selectProjectInBar(page, project.id); await work().getByRole('tab', { name: '剧本', exact: true }).click(); await expect(script()).toBeVisible(); };
  await open();

  await check('空剧本直接进入编辑；输入 Markdown 后停在编辑，「阅读」在保存前不能点；大纲同时认「## 标题」和「1. 场二」', async () => {
    await expect(body()).toBeEnabled(); await expect(viewBtn('编辑')).toHaveAttribute('aria-pressed', 'true');
    await expect(script()).toContainText('支持 Markdown');
    await script().getByLabel('剧本标题').fill('第54集｜地下那声停'); await body().fill(markdown);
    await expect(viewBtn('阅读')).toBeDisabled(); await expect(script()).toContainText('有未保存修改');
    await expect(outline()).toHaveCount(3);
    await expect(outline().nth(0)).toHaveText('场一｜内景｜地下管渠·第三段｜日'); await expect(outline().nth(1)).toHaveText('1. 场二｜外景｜竖井口｜当日稍晚'); await expect(outline().nth(2)).toHaveText('场三｜外景｜竖井口｜次日');
    await outline().nth(2).click(); assert.ok(await body().evaluate(t => t.selectionStart > 0), 'edit mode jumps in the text');
    await script().getByRole('button', { name: '保存剧本' }).click(); await expect(script().getByRole('button', { name: '保存剧本' })).toBeDisabled();
    await expect(body()).toBeVisible(); // stays in edit after saving
  });

  await check('重新打开默认「阅读」：标题、加粗、斜体、引用、列表、分隔线按 Markdown 显示；网页代码和链接都只是文字', async () => {
    await open(); await expect(viewBtn('阅读')).toHaveAttribute('aria-pressed', 'true'); await expect(body()).toHaveCount(0);
    await expect(script().locator('.ca-script-title')).toHaveText('第54集｜地下那声停');
    await expect(reader().getByRole('heading', { name: '场一｜内景｜地下管渠·第三段｜日' })).toBeVisible();
    await expect(reader().locator('strong', { hasText: '工头' })).toBeVisible(); await expect(reader().locator('em', { hasText: '水里也都是。' })).toBeVisible();
    await expect(reader().locator('blockquote')).toHaveText('【字幕】半月后。');
    await expect(reader().locator('ul > li')).toHaveText(['运料车', '木柱']); await expect(reader().locator('hr')).toHaveCount(1);
    await expect(reader().locator('ol')).toHaveAttribute('start', '1'); await expect(reader().locator('ol > li')).toHaveText('场二｜外景｜竖井口｜当日稍晚');
    // Same line keeps its break: two dialogue lines in one paragraph.
    assert.equal(await reader().locator('p', { hasText: '车怎么停了' }).locator('br').count(), 1);
    await expect(reader()).toContainText('<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>[外链](https://example.com/a.png)');
    assert.equal(await reader().locator('img, script, a, iframe').count(), 0); assert.equal(await page.evaluate(() => window.__xss), undefined);
    if (process.env.SCRIPT_MD_SHOTS) await page.screenshot({ path: path.join(process.env.SCRIPT_MD_SHOTS, 'script-read.png') });
  });

  await check('阅读状态点场次大纲滚到对应标题；切到编辑后可改，保存后仍可切回阅读', async () => {
    const scrolled = () => reader().evaluate(el => el.scrollTop);
    assert.equal(await scrolled(), 0);
    await outline().nth(2).click(); await expect.poll(scrolled).toBeGreaterThan(100);
    const head = reader().getByRole('heading', { name: '场三｜外景｜竖井口｜次日' }); await expect(head).toBeInViewport();
    await viewBtn('编辑').click(); await expect(body()).toBeEnabled(); await body().fill(markdown + '\n\n## 场四｜内景｜工棚｜夜'); await expect(viewBtn('阅读')).toBeDisabled(); await expect(outline()).toHaveCount(4);
    await script().getByRole('button', { name: '保存剧本' }).click(); await expect(viewBtn('阅读')).toBeEnabled();
    await viewBtn('阅读').click(); await expect(reader().getByRole('heading', { name: '场四｜内景｜工棚｜夜' })).toBeAttached();
    const saved = await api('/project-assets/projects/' + project.id + '/script'); assert.ok(saved.content.endsWith('## 场四｜内景｜工棚｜夜'), 'stored as plain Markdown text');
  });

  const saveAndRead = async text => {
    if (await viewBtn('编辑').getAttribute('aria-pressed') !== 'true') await viewBtn('编辑').click();
    await body().fill(text); await script().getByRole('button', { name: '保存剧本' }).click(); await expect(viewBtn('阅读')).toBeEnabled();
    await open(); await expect(viewBtn('阅读')).toHaveAttribute('aria-pressed', 'true');
  };
  const inReader = loc => loc.evaluate(el => { const box = el.closest('.ca-script-reader').getBoundingClientRect(), r = el.getBoundingClientRect(); return r.top >= box.top - 1 && r.top < box.bottom; });

  await check('FE1-R1 反例：只有「## 」或「## ###」的空标题行，保存并重新打开阅读不会卡住，下一行正文照常显示', async () => {
    await saveAndRead('## \n## ###\n空标题后的正文。\n\n## 正常标题\n正常段落。');
    await expect(reader()).toContainText('空标题后的正文。', { timeout: 5000 }); await expect(reader()).toContainText('## ###');
    await expect(reader().getByRole('heading')).toHaveText(['正常标题']); await expect(outline()).toHaveText(['正常标题']);
  });

  await check('FE1-R2 反例：旧写法「1、第一场」「2、第二场」中间无空行，阅读状态点「2、第二场」后第二场原文进入阅读视口', async () => {
    await saveAndRead(['1、第一场', ...Array.from({ length: 52 }, (_, i) => '第一场正文 ' + (i + 1)), '2、第二场', '第二场正文开头。'].join('\n'));
    await expect(outline()).toHaveText(['1、第一场', '2、第二场']);
    const second = reader().locator('p', { hasText: '2、第二场' }); assert.equal(await inReader(second), false, 'starts below the fold');
    await outline().nth(1).click();
    await expect.poll(() => inReader(second)).toBe(true); assert.equal(await inReader(reader().getByText('第二场正文开头。')), true);
  });

  await check('宽屏：默认「适中」三栏收拢居中、正文不超过 860；切「铺满」后变宽并记住；大纲和右栏高度跟内容走；没有资产时右栏只写一行', async () => {
    await page.setViewportSize({ width: 1920, height: 1000 }); await open();
    const cols = script().locator('.ca-script-cols'), width = name => script().getByRole('group', { name: '正文宽度' }).getByRole('button', { name });
    await expect(width('适中')).toHaveAttribute('aria-pressed', 'true');
    const box = async () => { const c = await cols.boundingBox(), host = await script().boundingBox(), r = await reader().boundingBox(); return { w: c.width, left: c.x - host.x, right: host.x + host.width - c.x - c.width, reader: r.width }; };
    let b = await box(); assert.ok(b.w <= 1401, 'group at most 1400 wide: ' + b.w); assert.ok(Math.abs(b.left - b.right) < 4, 'centered'); assert.ok(b.reader <= 861, 'text at most 860: ' + b.reader);
    const nav = await script().getByRole('navigation', { name: '场次大纲' }).boundingBox(), readerBox = await reader().boundingBox(); assert.ok(nav.height < readerBox.height, 'outline only as tall as its content');
    const mentions = script().getByRole('complementary', { name: '剧本中出现的资产' }); await expect(mentions).toContainText('本项目还没有人物、场景、道具'); await expect(mentions.locator('h4')).toHaveCount(0);
    if (process.env.SCRIPT_MD_SHOTS) await page.screenshot({ path: path.join(process.env.SCRIPT_MD_SHOTS, 'script-wide-mid.png') });
    await width('铺满').click(); await expect(width('铺满')).toHaveAttribute('aria-pressed', 'true');
    b = await box(); assert.ok(b.w > 1500, 'full spreads out: ' + b.w); assert.ok(b.reader > 1100, 'text widens: ' + b.reader);
    if (process.env.SCRIPT_MD_SHOTS) await page.screenshot({ path: path.join(process.env.SCRIPT_MD_SHOTS, 'script-wide-full.png') });
    await open(); await expect(width('铺满')).toHaveAttribute('aria-pressed', 'true'); // remembered on this computer
    await viewBtn('编辑').click(); assert.ok((await body().boundingBox()).width > 1100, 'edit mode uses the same width');
    await width('适中').click(); assert.ok((await body().boundingBox()).width <= 861);
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await check('FE1-R1 反例（#72）：项目有资产但场景列表 503 时，右栏不说「本项目还没有」，写读取失败；剧本照常可读；恢复后列出资产', async () => {
    await api('/project-assets/assets', { project_id: project.id, kind: 'character', name: '李四' });
    const fail = route => new URL(route.request().url()).searchParams.get('kind') === 'scene' && route.request().method() === 'GET' ? route.fulfill({ status: 503, json: { error: '服务暂时不可用' } }) : route.fallback();
    const assetList = url => url.pathname === '/api/project-assets/assets';
    await page.route(assetList, fail);
    await open(); const mentions = script().getByRole('complementary', { name: '剧本中出现的资产' });
    await expect(mentions).toContainText('资产列表没有读到'); await expect(mentions).not.toContainText('本项目还没有');
    await expect(reader()).toBeVisible();
    await page.unroute(assetList, fail);
    await open(); await expect(mentions.locator('li', { hasText: '李四' })).toBeVisible(); await expect(mentions).not.toContainText('资产列表没有读到');
  });

  await check('FE1-R2 反例（#72）：从「界面设置 → 重置导航与浏览偏好」重置：剧本页当页回到「适中」且未保存正文保留；在别的页面重置、刷新后首次打开剧本也是「适中」', async () => {
    const width = name => script().getByRole('group', { name: '正文宽度' }).getByRole('button', { name });
    const reset = async () => { await page.locator('.sidebar').getByRole('button', { name: '界面设置', exact: true }).click(); const d = page.getByRole('dialog', { name: '界面设置' }); await d.getByRole('button', { name: '重置导航与浏览偏好' }).click(); await d.getByRole('button', { name: '关闭界面设置' }).click(); };
    // On the script page, with an unsaved edit.
    await open(); await width('铺满').click(); await viewBtn('编辑').click();
    const before = await body().inputValue(); await body().fill(before + '\n未保存的一行'); await expect(script()).toContainText('有未保存修改');
    await reset();
    await expect(width('适中')).toHaveAttribute('aria-pressed', 'true'); await expect(body()).toHaveValue(before + '\n未保存的一行'); await expect(script()).toContainText('有未保存修改');
    assert.equal(await page.evaluate(() => localStorage.getItem('shiguang.scriptWidth.v1')), null);
    await body().fill(before); await expect(script().getByRole('button', { name: '保存剧本' })).toBeDisabled();
    // From another page, before the script view has mounted.
    await width('铺满').click(); assert.equal(await page.evaluate(() => localStorage.getItem('shiguang.scriptWidth.v1')), '"full"');
    await page.goto(origin + '/#/project-videos'); await page.reload(); await reset();
    await open(); await expect(width('适中')).toHaveAttribute('aria-pressed', 'true');
  });

  assert.deepEqual(errors, [], '页面不应出现脚本错误'); assert.deepEqual(external, [], '不应请求外部地址');
  passed = true;
} finally {
  if (!passed) { console.error(logs.slice(-3000)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'creative-script-md-failure.png') }).catch(() => {}); }
  await browser?.close(); child.kill('SIGTERM'); await exited; await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
