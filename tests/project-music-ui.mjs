// 项目音乐页 · 真实应用界面测试。先 npm run build；使用系统 Chrome（CHROME_PATH 可改）、全新临时库、合成音频。
// 运行：node --test tests/project-music-ui.mjs
// 只保证流程走得通、不错位、深色主题下可读；画风好不好以用户看实物为准。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {tempDirectories} from './helpers/temp-cleanup.mjs';
import {repo, startServer, synth} from './helpers/project-music-server.mjs';
import {lowContrast} from './helpers/contrast.mjs';

const makeTemp = tempDirectories(test, 'sg-project-music-ui-');

test('项目音乐页：新建歌曲、上传一轮、先补上一轮、播放、当前最好、淘汰区、配色开关、定稿', async t => {
  await fs.access(path.join(repo, 'dist', 'index.html')).catch(() => assert.fail('请先 npm run build'));
  const base = await makeTemp(t);
  const audio = path.join(base, 'audio');
  await fs.mkdir(audio);
  const mp3 = await synth(audio, '合成-甲.mp3', {freq: 330, seconds: 3});
  const wav = await synth(audio, '合成-乙.wav', {freq: 523, seconds: 3, volume: 0.5});
  const s = await startServer(t, base);
  const pid = (await s.call('POST', '/projects', {name: '合成界面项目'})).body.id;
  const instance = (await (await fetch(s.origin + '/api/session')).json()).instanceId;

  const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, timeout: 30000});
  t.after(() => browser.close());
  // 浏览器放在美国西部时区：页面上的时间仍应按北京时间显示。
  const context = await browser.newContext({viewport: {width: 1360, height: 900}, timezoneId: 'America/Los_Angeles'});
  await context.addInitScript(([lib, project]) => {
    if (!localStorage.getItem('sg-test-seeded')) {
      localStorage.setItem('shiguang.projectLocation.v1:' + lib, JSON.stringify({projectId: project, recent: [project], lastInContainer: {}}));
      localStorage.setItem('sg-test-seeded', '1');
    }
  }, [instance, pid]);
  context.setDefaultTimeout(20000); // 卡住时尽快报出是哪一步，不等到整条用例超时
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(s.origin + '/#/project-music');
  const root = page.locator('section.sg-music');
  await root.getByText('还没有歌曲').waitFor();

  // 新建歌曲
  await root.getByRole('button', {name: '新建第一首歌'}).click();
  await page.getByLabel('歌名').fill('合成歌曲');
  await page.getByRole('button', {name: '新建', exact: true}).click();
  await root.getByRole('heading', {name: '合成歌曲'}).waitFor();

  // 上传第一轮：提示词 + 两个文件
  await root.getByRole('button', {name: '上传第一轮'}).first().click();
  const dialog = page.getByRole('dialog', {name: /上传新一轮/});
  await dialog.getByLabel('风格').fill('合成风格 女声 慢板');
  await dialog.getByLabel('歌词').fill('第一句\n第二句');
  await dialog.getByLabel('Suno 会员档位').selectOption('unknown');
  await dialog.locator('input[type=file]').setInputFiles([mp3, wav]);
  await dialog.getByRole('button', {name: '开新一轮并上传'}).click();
  await dialog.getByText('已保存 · A').waitFor({timeout: 30000});
  await dialog.getByText('已保存 · B').waitFor({timeout: 30000});
  await dialog.getByRole('button', {name: '完成'}).click();
  const round1 = root.locator('article[aria-label="第 1 轮"]');
  await round1.locator('.sgm-version').nth(1).waitFor();
  assert.equal(await round1.locator('.sgm-version').count(), 2);
  assert.ok(await round1.locator('.sgm-wave rect').count() > 100, '版本显示真实波形');
  assert.equal(await round1.getByText('不确定').count(), 1, '档位显示「不确定」');

  // 先补上一轮
  await root.getByRole('button', {name: '上传新一轮'}).click();
  await page.getByRole('dialog', {name: '先补上一轮'}).getByText(/第 1 轮还缺「问题整理」「下一轮方向」/).waitFor();
  await page.getByRole('button', {name: '知道了'}).click();
  assert.ok(await round1.getByText(/开新一轮前，先补上这一轮/).isVisible());

  // 自己各写一句就算补上（不要求条目格式），作者记为「你」，时间按北京时间显示
  await round1.locator('.sgm-block', {hasText: '问题整理'}).getByRole('button', {name: '自己写一句'}).click();
  await round1.getByLabel('你写的问题整理（一句话也行）').fill('副歌有点闷');
  await round1.locator('.sgm-block', {hasText: '问题整理'}).getByRole('button', {name: '保存'}).click();
  await round1.getByText('副歌有点闷').waitFor();
  const stamp = await round1.locator('.sgm-part.is-user .sgm-author').first().innerText();
  const bj = ms => { const p = Object.fromEntries(new Intl.DateTimeFormat('zh-CN', {timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false}).formatToParts(new Date(ms)).map(x => [x.type, x.value])); return `${p.year}-${p.month}-${p.day} ${p.hour}:`; };
  assert.match(stamp, /^你 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, stamp);
  assert.ok([Date.now(), Date.now() - 120000].map(bj).some(x => stamp.includes(x)), `浏览器在美国西部时区，页面仍应显示北京时间：${stamp}`);
  await round1.locator('.sgm-block', {hasText: '下一轮方向'}).getByRole('button', {name: '自己写一句'}).click();
  await round1.getByLabel('你写的下一轮方向（一句话也行）').fill('只把慢板改成中速');
  await round1.locator('.sgm-block', {hasText: '下一轮方向'}).getByRole('button', {name: '保存'}).click();
  await round1.getByText('只把慢板改成中速').waitFor();
  await root.getByRole('button', {name: '上传新一轮'}).click();
  const next = page.getByRole('dialog', {name: /第 2 轮/});
  await next.getByLabel('风格').fill('合成风格 女声 中速');
  await next.getByRole('button', {name: '只开新一轮'}).click();
  await root.locator('article[aria-label="第 2 轮"]').waitFor();
  await next.getByRole('button', {name: '关闭'}).last().click();
  assert.ok(await root.locator('article[aria-label="第 2 轮"]').getByText('和上一轮比：改了风格').isVisible());

  // 播放、当前最好、淘汰区
  if (await round1.locator('.sgm-round-toggle').getAttribute('aria-expanded') !== 'true') await round1.locator('.sgm-round-toggle').click();
  await round1.getByRole('button', {name: '播放 第 1 轮 A'}).click();
  const player = root.getByRole('region', {name: '项目音乐播放条'});
  await player.waitFor();
  assert.match(await player.innerText(), /合成歌曲[\s\S]*第 1 轮 · A/);
  await page.waitForFunction(() => /^0:0[1-3] \//.test(document.querySelector('.sgm-player-clock')?.textContent ?? ''), null, {timeout: 10000});
  await round1.getByRole('button', {name: '把第 1 轮 A 设为当前最好'}).click();
  await round1.getByText('当前最好').first().waitFor();
  await round1.getByRole('button', {name: '淘汰第 1 轮 A'}).click();
  await page.getByRole('dialog', {name: '淘汰当前最好？'}).getByRole('button', {name: '确定'}).click();
  await root.getByText('淘汰区 · 1 个版本').waitFor();
  assert.equal(await root.getByText('还没有选「当前最好」').count(), 1);

  // 配色开关只记在本浏览器
  await root.getByRole('radio', {name: '工作室'}).click();
  assert.equal(await root.getAttribute('data-sg-palette'), 'studio');
  await page.reload();
  await root.locator('article[aria-label="第 1 轮"]').waitFor();
  assert.equal(await root.getAttribute('data-sg-palette'), 'studio');

  // 深色主题 + 跟随主题：主要文字对比度够；页面不出现横向溢出
  await page.evaluate(() => { localStorage.setItem('shiguang.theme', 'dark'); localStorage.setItem('shiguang.musicPalette.v1', 'follow'); });
  for (const width of [1360, 820]) {
    await page.setViewportSize({width, height: 900});
    await page.reload();
    await root.locator('article[aria-label="第 1 轮"]').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    const bad = await lowContrast(page, '.sg-music h1, .sg-music h2, .sg-music h3, .sg-music h4, .sg-music p, .sg-music dd, .sg-music li, .sg-music .sgm-btn, .sg-music .sgm-pill, .sg-music .sgm-version-label', 4.5);
    assert.deepEqual(bad, [], '深色主题下有看不清的文字');
    const overflow = await root.evaluate(el => el.scrollWidth - el.clientWidth);
    assert.ok(overflow <= 1, `宽 ${width} 时页面横向溢出 ${overflow}px`);
  }

  // 定稿：默认版本、默认「待确认」分类
  await page.setViewportSize({width: 1360, height: 900});
  await root.getByRole('button', {name: '定稿'}).click();
  const fin = page.getByRole('dialog', {name: '定稿'});
  await fin.getByLabel('音乐库里的文件名').fill('合成歌曲定稿');
  await fin.getByRole('button', {name: '定稿'}).click();
  await root.getByText(/已定稿：第 1 轮 B，已复制进音乐库「待确认」，文件名 合成歌曲定稿\.wav/).waitFor({timeout: 30000});
  await fs.access(path.join(s.personal, 'system_music', '合成歌曲定稿.wav'));
  assert.deepEqual(errors, []);
});
