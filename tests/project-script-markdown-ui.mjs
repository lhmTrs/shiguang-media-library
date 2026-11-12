// 项目剧本正文的 Markdown 阅读 / 编辑切换。真实本地服务 + 合成剧本；不接入真实素材库，不调用模型。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';

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
  const open = async () => { await page.goto(origin + '/#/project-assets'); await page.reload(); await expect(work()).toBeVisible(); await page.getByLabel('资产所属项目').selectOption(project.id); await work().getByRole('tab', { name: '剧本', exact: true }).click(); await expect(script()).toBeVisible(); };
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

  assert.deepEqual(errors, [], '页面不应出现脚本错误'); assert.deepEqual(external, [], '不应请求外部地址');
  passed = true;
} finally {
  if (!passed) { console.error(logs.slice(-3000)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'creative-script-md-failure.png') }).catch(() => {}); }
  await browser?.close(); child.kill('SIGTERM'); await exited; await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
