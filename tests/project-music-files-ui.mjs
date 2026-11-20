// 项目音乐 ·「文件」标签界面测试（PR4）。先 npm run build；使用系统 Chrome、全新临时库、合成音频。
// 运行：node --test tests/project-music-files-ui.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {chromium} from '@playwright/test';
import {tempDirectories} from './helpers/temp-cleanup.mjs';
import {repo, startServer, synth} from './helpers/project-music-server.mjs';
import {lowContrast} from './helpers/contrast.mjs';

const makeTemp = tempDirectories(test, 'sg-project-music-files-ui-');
const uuid = () => crypto.randomUUID();

test('项目音乐 · 文件标签：歌曲｜文件切换并记住、文件夹树与波形、播放、新建与改名、上传、加入歌曲、跳回歌曲、深色可读', async t => {
  await fs.access(path.join(repo, 'dist', 'index.html')).catch(() => assert.fail('请先 npm run build'));
  const base = await makeTemp(t);
  const audio = path.join(base, 'audio');
  await fs.mkdir(audio);
  const a = await synth(audio, 'Suno下载甲.mp3', {freq: 330, seconds: 3});
  const b = await synth(audio, '要上传的.wav', {freq: 520, seconds: 2});
  const s = await startServer(t, base);
  const pid = (await s.call('POST', '/projects', {name: '合成文件界面'})).body.id;
  const M = `/project-music/projects/${pid}`, F = M + '/files';
  await s.call('POST', F + '/folders', {parent: '', name: 'Suno下载'});
  {
    const bytes = await fs.readFile(a), requestId = uuid();
    await s.call('POST', F + '/imports', {requestId, folder: 'Suno下载', fileName: 'Suno下载甲.mp3', bytes: bytes.length}, {asPage: true});
    assert.equal((await s.call('PUT', F + `/imports/${requestId}/content`, bytes)).body.status, 'ready');
  }
  let song = (await s.call('POST', M + '/songs', {requestId: uuid(), title: '合成歌'}, {asPage: true})).body;
  song = (await s.call('POST', M + `/songs/${song.id}/rounds`, {requestId: uuid(), prompt: {tool: 'Suno', style: '合成'}}, {asPage: true})).body;
  const instance = (await (await fetch(s.origin + '/api/session')).json()).instanceId;

  const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, timeout: 30000});
  t.after(() => browser.close());
  const context = await browser.newContext({viewport: {width: 1360, height: 900}});
  await context.addInitScript(([lib, project]) => {
    if (!localStorage.getItem('sg-test-seeded')) {
      localStorage.setItem('shiguang.projectLocation.v1:' + lib, JSON.stringify({projectId: project, recent: [project], lastInContainer: {}}));
      localStorage.setItem('sg-test-seeded', '1');
    }
  }, [instance, pid]);
  context.setDefaultTimeout(20000);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(s.origin + '/#/project-music');
  const root = page.locator('section.sg-music');
  await root.getByRole('heading', {name: '合成歌'}).waitFor();

  // 切到「文件」：文件夹树里有「♪ 歌曲」和 Suno下载；进文件夹看到真实波形
  await root.getByRole('tab', {name: /文件/}).click();
  const tree = root.getByRole('navigation', {name: '项目音乐文件文件夹树'});
  await tree.getByRole('button', {name: /Suno下载/}).click();
  const row = root.locator('.sgf-row', {hasText: 'Suno下载甲.mp3'});
  await row.waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.sgf-row .sgm-wave rect').length > 50, null, {timeout: 20000});
  assert.equal(await root.getByRole('button', {name: '新建歌曲'}).count(), 0, '文件标签里不显示新建歌曲');
  // 播放：底部播放条显示文件名
  await row.getByRole('button', {name: '播放 Suno下载甲.mp3'}).click();
  const player = root.getByRole('region', {name: '项目音乐播放条'});
  await player.waitFor();
  assert.match(await player.innerText(), /Suno下载甲\.mp3[\s\S]*Suno下载/);
  await row.getByRole('button', {name: '暂停 Suno下载甲.mp3'}).click();

  // 记住标签和文件夹
  await page.reload();
  await root.locator('.sgf-row', {hasText: 'Suno下载甲.mp3'}).waitFor();
  assert.equal(await root.getByRole('tab', {name: /文件/}).getAttribute('aria-selected'), 'true');

  // 新建子文件夹、改名
  await root.getByRole('button', {name: '新建文件夹'}).click();
  await page.getByRole('dialog', {name: '新建文件夹'}).getByLabel('文件夹名').fill('第一批');
  await page.getByRole('dialog', {name: '新建文件夹'}).getByRole('button', {name: '新建'}).click();
  await root.getByRole('navigation', {name: '项目音乐文件位置'}).getByRole('button', {name: '第一批'}).waitFor();
  await root.getByRole('button', {name: '改名'}).click();
  const rename = page.getByRole('dialog', {name: '改名'});
  await rename.getByLabel('新名字').fill('第一批（试听）');
  await rename.getByRole('button', {name: '改名'}).click();
  await root.getByRole('navigation', {name: '项目音乐文件位置'}).getByRole('button', {name: '第一批（试听）'}).waitFor();
  await fs.access(path.join(s.personal, 'music', `合成文件界面--${pid}`, 'Suno下载', '第一批（试听）'));

  // 上传到当前文件夹
  await root.getByRole('button', {name: '上传', exact: true}).click();
  const up = page.getByRole('dialog', {name: /上传到「Suno下载\/第一批（试听）」/});
  await up.locator('input[type=file]').setInputFiles([b]);
  await up.getByRole('button', {name: '上传', exact: true}).click();
  await up.getByText('已保存').waitFor({timeout: 30000});
  await up.getByRole('button', {name: '完成'}).click();
  await root.locator('.sgf-row', {hasText: '要上传的.wav'}).waitFor();

  // 加入歌曲：选歌、选轮；加入后行上显示「已加入」，歌曲里多一个版本
  await root.getByRole('navigation', {name: '项目音乐文件位置'}).getByRole('button', {name: 'Suno下载', exact: true}).click();
  const row2 = root.locator('.sgf-row', {hasText: 'Suno下载甲.mp3'});
  await row2.getByRole('button', {name: '把 Suno下载甲.mp3 加入歌曲'}).click();
  const add = page.getByRole('dialog', {name: '加入歌曲'});
  await add.getByText(/文件留在「文件」里，不会复制一份/).waitFor();
  await add.getByRole('button', {name: '加入', exact: true}).click();
  await row2.getByText(/已加入：合成歌 第 1 轮 A/).waitFor();

  // 桌面按钮：测试里关掉了原生组件，按钮不可用并说明原因
  assert.equal(await root.getByRole('button', {name: '在访达中显示'}).isDisabled(), true);
  await row2.getByRole('checkbox', {name: '选择 Suno下载甲.mp3'}).check();
  assert.equal(await root.getByRole('button', {name: '复制给剪辑软件'}).isDisabled(), true);
  await root.getByText(/复制给剪辑软件、在访达中显示要在运行拾光的这台 Mac 上用/).waitFor();
  assert.ok(!(await root.innerText()).includes(s.personal), '页面不显示本机路径');

  // 很长的文件夹名：窄屏时文件夹树不能被撑开，名字省略、数字留在画面里（验收 PR4 P3-1）
  const longName = '很长的文件夹名'.repeat(10) + '结尾';
  await s.call('POST', F + '/folders', {parent: '', name: longName});
  // 深色主题 + 窄屏：文字看得清，不横向溢出
  await page.evaluate(() => { localStorage.setItem('shiguang.theme', 'dark'); localStorage.setItem('shiguang.musicPalette.v1', 'follow'); });
  for (const width of [1360, 820]) {
    await page.setViewportSize({width, height: 900});
    await page.reload();
    await root.locator('.sgf-row').first().waitFor();
    const bad = await lowContrast(page, '.sg-music .sgf strong, .sg-music .sgf small, .sg-music .sgf button, .sg-music .sgm-tabs button, .sg-music .sgm-pill, .sg-music .sgf-row-details', 4.5);
    assert.deepEqual(bad, [], '深色主题下有看不清的文字');
    const overflow = await root.evaluate(el => el.scrollWidth - el.clientWidth);
    assert.ok(overflow <= 1, `宽 ${width} 时页面横向溢出 ${overflow}px`);
    const tree = await root.locator('.sgf-tree').evaluate(el => el.scrollWidth - el.clientWidth);
    assert.ok(tree <= 1, `宽 ${width} 时文件夹树被长名字撑开 ${tree}px`);
    const count = await root.locator('.sgf-tree button', {hasText: '♪ 歌曲'}).locator('small').evaluate(el => { const r = el.getBoundingClientRect(), t = el.closest('.sgf-tree').getBoundingClientRect(); return r.right <= t.right + 1; });
    assert.ok(count, `宽 ${width} 时「♪ 歌曲」后面的数字被挤出画面`);
  }
  for (const palette of ['paper', 'studio', 'gallery']) {
    await page.evaluate(p => localStorage.setItem('shiguang.musicPalette.v1', p), palette);
    await page.reload();
    await root.locator('.sgf-row').first().waitFor();
    assert.deepEqual(await lowContrast(page, '.sg-music .sgf strong, .sg-music .sgf small, .sg-music .sgf button, .sg-music .sgm-tabs button', 4.5), [], palette);
  }

  // 「♪ 歌曲」跳回歌曲标签，加入的版本在第 1 轮里
  await root.getByRole('button', {name: /♪ 歌曲/}).click();
  assert.equal(await root.getByRole('tab', {name: /歌曲/}).getAttribute('aria-selected'), 'true');
  await root.locator('article[aria-label="第 1 轮"] .sgm-version').first().waitFor();
  assert.ok(await root.getByText('音乐库：复用已有的「Suno下载甲.mp3」').first().isVisible());
  // 在访达里把这首所在的文件夹挪走：版本行写明文件不在原位置，以及怎么恢复（验收 PR4 P3-2）
  const folderOnDisk = path.join(s.personal, 'music', `合成文件界面--${pid}`, 'Suno下载');
  await fs.rename(folderOnDisk, path.join(base, '挪走了'));
  await page.reload();
  await root.getByText(/文件不在原位置（离线）：原来在「项目音乐 › Suno下载 \/ Suno下载甲\.mp3」。在访达里把它放回原处/).first().waitFor();
  await fs.rename(path.join(base, '挪走了'), folderOnDisk);
  assert.deepEqual(errors, []);
});
