// 项目资产页主按钮悬停配色回归：通用规则 .ca-workspace button:hover 把文字改成绿色，主按钮底色也是绿色 → 字看不见。
// 六套主题下逐个悬停：页面上真实的主按钮，以及合并浮窗、一键统一、拖入导入、参考图片、已勾选图片勾选框等容器里的主按钮
// （这些浮窗要走完整流程才出现，这里在工作区内放同样结构的按钮核对样式）。悬停后文字和底色对比度须 ≥ 3。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { selectProjectInBar } from './helpers/path-bar.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'primary-hover-'));
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const errors = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal'), CODEX_HOME: path.join(temp, 'no-codex'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', MEDIA_CODEX_AUTOCONNECT: '0', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body) { const response = await fetch(origin + '/api' + p, { method: body ? 'POST' : 'GET', headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const data = await response.json().catch(() => ({})); assert.ok(response.ok, p + ' ' + response.status + ' ' + JSON.stringify(data)); return data; }
const rid = () => crypto.randomUUID();
const evidence = process.env.CREATIVE_TEST_EVIDENCE;
const shot = async name => { if (evidence) { await fs.mkdir(evidence, { recursive: true }); await page.screenshot({ path: path.join(evidence, name + '.png') }); } };
const THEMES = ['', 'dark', 'midnight', 'sepia', 'graphite', 'ocean'];
// 放进工作区的同结构按钮：容器类名照抄各组件
const PROBES = [
  ['合并浮窗', '<div class="cm-dialog"><button type="button" class="ca-primary">确认合并</button></div>'],
  ['合并提示条', '<div class="cm-banner"><button type="button" class="ca-primary">逐个合并</button></div>'],
  ['合并完成提示', '<div class="cm-done"><button type="button" class="ca-primary">下一个</button></div>'],
  ['待核对提示', '<div class="cm-pending"><button type="button" class="ca-primary">立即核对</button></div>'],
  ['一键统一浮窗', '<div class="ca-align"><button type="button" class="ca-primary">确认统一</button></div>'],
  ['一键统一提示条', '<div class="aa-banner"><button type="button" class="ca-primary">去统一</button></div>'],
  ['拖入导入浮窗', '<div class="ca-modal ca-drop-dialog"><button type="button" class="ca-primary">开始导入</button></div>'],
  ['参考图片浮窗', '<div class="ca-modal ca-image-dialog"><button type="button" class="ca-primary">设为默认</button></div>'],
  ['已勾选的图片勾选框', '<div class="ca-tile" style="position:relative;width:80px;height:80px"><button type="button" role="checkbox" class="ca-tile-pick" aria-checked="true" style="opacity:1;pointer-events:auto">✓</button></div>'],
];

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  const S = await api('/project-series', { name: '悬停核对剧', software: 'jianying', request_id: rid() });
  const q = await api(`/project-series/${S.id}/seasons`, { request_id: rid() });
  const projectId = (await api(`/project-series/${S.id}/episodes`, { season_id: q.id, expected_episode_no: 1, request_id: rid() })).project.id;
  await api('/project-assets/assets', { project_id: projectId, kind: 'character', name: '张三' });

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => { try { localStorage.setItem('shiguang.refreshSeconds', '0'); } catch {} });
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/#/all'); await expect(page.locator('.ppb').first()).toHaveAttribute('data-project', /./);
  await selectProjectInBar(page, projectId);
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '项目资产', exact: true }).click();
  const work = page.getByRole('region', { name: '项目资产库' }); await expect(work).toBeVisible();
  await expect(work.getByText('张三').first()).toBeVisible();

  await page.evaluate(probes => {
    const box = document.createElement('div'); box.id = 'hover-probes'; box.style.cssText = 'position:fixed;left:20px;bottom:20px;z-index:99999;display:flex;gap:8px;flex-wrap:wrap;max-width:900px';
    for (const [name, html] of probes) { const cell = document.createElement('div'); cell.dataset.probe = name; cell.innerHTML = html; cell.firstElementChild.style.position = cell.firstElementChild.style.position || 'static'; box.appendChild(cell); }
    document.querySelector('.ca-workspace').appendChild(box);
  }, PROBES);
  // 关掉过渡：切换主题、悬停后背景色有过渡动画，读到的是中间色
  await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });

  const lum = c => { const m = c.match(/[\d.]+/g).map(Number); const [r, g, b] = (c.startsWith('color(') ? m.slice(0, 3).map(v => v * 255) : m.slice(0, 3)).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const failures = [], rows = [];
  for (const theme of THEMES) {
    await page.evaluate(t => { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }, theme);
    const real = await work.locator('button.ca-primary:visible:not(:disabled):not(#hover-probes button)').all();
    const targets = [...real.map((l, i) => ['页面主按钮#' + i, l]), ...PROBES.map(([name]) => [name, page.locator(`#hover-probes [data-probe="${name}"] button`)])];
    assert.ok(real.length >= 1, '页面上没有可悬停的主按钮');
    for (const [name, loc] of targets) {
      await loc.hover();
      const { color, bg, text } = await loc.evaluate(el => { const s = getComputedStyle(el); return { color: s.color, bg: s.backgroundColor, text: el.textContent.trim().slice(0, 12) }; });
      const r = ratio(color, bg); rows.push(`${theme || 'forest'}\t${name}\t${text}\t${color}\t${bg}\t${r.toFixed(2)}`);
      if (r < 3) failures.push(`${theme || '森林绿'} / ${name}「${text}」悬停后文字 ${color} 底色 ${bg} 对比度 ${r.toFixed(2)}`);
    }
    await page.mouse.move(1400, 20);
    await page.locator('#hover-probes [data-probe="合并浮窗"] button').hover(); await shot('hover-' + (theme || 'forest'));
  }
  if (evidence) await fs.writeFile(path.join(evidence, 'hover-contrast.tsv'), 'theme\ttarget\ttext\tcolor\tbackground\tratio\n' + rows.join('\n') + '\n');
  assert.deepEqual(failures, [], '主按钮悬停看不清：\n' + failures.join('\n'));
  console.log('PASS 六套主题下主按钮和已勾选勾选框悬停后文字可见（' + rows.length + ' 项，对比度均 ≥ 3）');
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  if (!passed) console.log(logs.slice(-3000));
  await browser?.close(); child.kill('SIGTERM'); let timer; if (await Promise.race([exited, new Promise(r => timer = setTimeout(() => r('timeout'), 10000))]) === 'timeout') { child.kill('SIGKILL'); await exited; } clearTimeout(timer);
  await fs.rm(temp, { recursive: true, force: true });
}
