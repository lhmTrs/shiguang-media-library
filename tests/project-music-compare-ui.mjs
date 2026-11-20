// 项目音乐 · A/B 对比页（PR 2）真实应用界面测试。先 npm run build；系统 Chrome、全新临时库、合成音频。
// 运行：node --test tests/project-music-compare-ui.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {chromium} from '@playwright/test';
import {tempDirectories} from './helpers/temp-cleanup.mjs';
import {repo, startServer, synth} from './helpers/project-music-server.mjs';
import {lowContrast} from './helpers/contrast.mjs';

const makeTemp = tempDirectories(test, 'sg-project-music-cmp-');
const uuid = () => crypto.randomUUID();

test('对比页：默认当前最好对最新、空格切换停在同一位置、音量对齐、盲听与揭晓、打点、歌词跳转、记结果', async t => {
  await fs.access(path.join(repo, 'dist', 'index.html')).catch(() => assert.fail('请先 npm run build'));
  const base = await makeTemp(t);
  const audio = path.join(base, 'audio');
  await fs.mkdir(audio);
  const loud = await synth(audio, '合成-响.mp3', {freq: 330, seconds: 8});
  const soft = await synth(audio, '合成-轻.mp3', {freq: 440, seconds: 6, volume: 0.4}); // 比 A 短，用来测「任意一版播完两版一起停」
  const s = await startServer(t, base);
  const pid = (await s.call('POST', '/projects', {name: '合成对比界面项目'})).body.id;
  const M = `/project-music/projects/${pid}`;
  let song = (await s.call('POST', M + '/songs', {requestId: uuid(), title: '合成对比歌'}, {asPage: true})).body;
  song = (await s.call('POST', M + `/songs/${song.id}/rounds`, {requestId: uuid(), prompt: {tool: 'Suno', style: '合成', lyrics: '第一句\n第二句'}}, {asPage: true})).body;
  const round = song.rounds[0];
  const up = async file => {
    const bytes = await fs.readFile(file), requestId = uuid();
    await s.call('POST', M + '/imports', {requestId, roundId: round.id, fileName: path.basename(file), bytes: bytes.length}, {asPage: true});
    return (await s.call('PUT', M + `/imports/${requestId}/content`, bytes)).body.versionId;
  };
  const vA = await up(loud), vB = await up(soft);
  song = (await s.call('GET', M + `/songs/${song.id}`)).body;
  song = (await s.call('PATCH', M + `/songs/${song.id}`, {expectedRevision: song.revision, bestVersionId: vA}, {asPage: true})).body;
  const r = song.rounds[0];
  await s.call('PATCH', M + `/rounds/${r.id}/agent-notes`, {expectedRevision: r.revision, session: '合成会话', lyricTimes: [
    {versionId: vA, method: '合成测试数据', lines: [{text: '第一句', startMs: 1000}, {text: '第二句', startMs: 4000}]},
    {versionId: vB, method: '合成测试数据', lines: [{text: '第一句', startMs: 1500}, {text: '第二句', startMs: 5000}]},
  ]});
  const instance = (await (await fetch(s.origin + '/api/session')).json()).instanceId;

  const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, timeout: 30000, args: ['--autoplay-policy=no-user-gesture-required']});
  t.after(() => browser.close());
  const context = await browser.newContext({viewport: {width: 1360, height: 900}});
  await context.addInitScript(([lib, project]) => localStorage.setItem('shiguang.projectLocation.v1:' + lib, JSON.stringify({projectId: project, recent: [project], lastInContainer: {}})), [instance, pid]);
  context.setDefaultTimeout(20000); // 卡住时尽快报出是哪一步，不等到整条用例超时
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(s.origin + '/#/project-music');
  const root = page.locator('section.sg-music');
  await root.getByRole('button', {name: '对比', exact: true}).click();
  const panel = root.getByRole('region', {name: 'A/B 对比'});
  await panel.waitFor();

  // 默认：当前最好（A）对最新（B）
  assert.equal(await panel.getByLabel('左边版本').inputValue(), vA);
  assert.equal(await panel.getByLabel('右边版本').inputValue(), vB);
  // 音量对齐：较响的 A 调低，数值来自服务端响度估算
  assert.match(await panel.locator('.sgm-hint').first().innerText(), /已对齐音量：第 1 轮 A 调低 \d+\.\d dB/);

  // 两版同时走，只放出一版
  await panel.getByRole('button', {name: '播放两版'}).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.sgm-compare audio')].every(a => !a.paused && a.currentTime > 0.8), null, {timeout: 10000});
  const vols = await page.$$eval('.sgm-compare audio', list => list.map(a => a.volume));
  assert.equal(vols.filter(v => v === 0).length, 1, '只有一版出声');
  assert.ok(vols[0] < vols[1] || vols[1] === 0, '响的 A 被调低');
  // 空格切换：换成另一版出声，两版位置一致
  await page.keyboard.press('Space');
  await page.waitForTimeout(400);
  const after = await page.$$eval('.sgm-compare audio', list => list.map(a => ({v: a.volume, t: a.currentTime})));
  assert.equal(after[0].v, 0, '切换后左边静音');
  assert.ok(after[1].v > 0, '切换后右边出声');
  assert.ok(Math.abs(after[0].t - after[1].t) < 0.3, `两版停在同一位置：${after[0].t} / ${after[1].t}`);
  assert.equal(await panel.getByRole('button', {name: /听 第 1 轮 B/}).getAttribute('aria-pressed'), 'true');

  // 打点，点标记两版一起跳过去
  await panel.getByRole('button', {name: '在当前位置打点'}).click();
  await panel.getByLabel('标记 1 名称').fill('副歌');
  await panel.getByRole('button', {name: '暂停两版'}).click();
  await panel.getByRole('button', {name: '跳到 副歌'}).click();
  const atMarker = await page.$$eval('.sgm-compare audio', list => list.map(a => a.currentTime));
  assert.ok(Math.abs(atMarker[0] - atMarker[1]) < 0.05);

  // 歌词：点一句，两版各跳到自己的那一句
  await panel.getByRole('button', {name: '第二句'}).click();
  const atLine = await page.$$eval('.sgm-compare audio', list => list.map(a => a.currentTime));
  assert.ok(Math.abs(atLine[0] - 4) < 0.05 && Math.abs(atLine[1] - 5) < 0.05, `歌词跳转：${atLine}`);

  // 盲听：只显示 1 号、2 号，版本选择收起；记结果后揭晓
  await panel.getByRole('button', {name: '盲听'}).click();
  assert.equal(await panel.getByLabel('左边版本').count(), 0);
  assert.equal(await panel.locator('.sgm-compare-track').filter({hasText: '第 1 轮'}).count(), 0, '盲听时不露出版本名');
  assert.ok(await panel.getByRole('button', {name: /听 1 号/}).isVisible());
  // 盲听不露底：不显示波形和总时长，两版是同一刻度的中性进度条，只显示当前位置
  assert.equal(await panel.locator('.sgm-compare-track .sgm-wave').count(), 0, '盲听时不显示波形');
  assert.equal(await panel.locator('.sgm-compare-track .sgm-neutral-bar').count(), 2);
  for (const t of await panel.locator('.sgm-compare-track .sgm-version-time').allInnerTexts()) assert.match(t, /^\d+:\d{2}$/, `盲听时不显示总时长：${t}`);
  await panel.getByRole('radio', {name: '1 号 更好'}).click();
  await panel.getByLabel(/一句话结果/).fill('副歌 1 号更稳');
  await panel.getByRole('button', {name: '保存对比结果'}).click();
  const note = await panel.getByRole('status').innerText();
  assert.match(note, /已存进第 1 轮的记录。1 号是 第 1 轮 [AB]，2 号是 第 1 轮 [AB]/);
  const oneIsB = /1 号是 第 1 轮 B/.test(note);
  // 保存即揭晓：波形和总时长恢复显示
  assert.equal(await panel.locator('.sgm-compare-track .sgm-wave').count(), 2);
  for (const t of await panel.locator('.sgm-compare-track .sgm-version-time').allInnerTexts()) assert.match(t, /^\d+:\d{2} \/ \d+:\d{2}$/, t);
  if (oneIsB) {
    await panel.getByRole('button', {name: /把 第 1 轮 B 设为当前最好/}).click();
    await panel.getByText('已是当前最好').waitFor();
  } else {
    assert.ok(await panel.getByText('已是当前最好').isVisible(), '1 号就是当前最好 A');
  }

  // 返回后，结果出现在这一轮的记录里
  await panel.getByRole('button', {name: '返回'}).click();
  const block = root.locator('article[aria-label="第 1 轮"] .sgm-block', {hasText: '对比结果'});
  await block.waitFor();
  assert.match(await block.innerText(), /第 1 轮 A ↔ 第 1 轮 B[\s\S]*盲听[\s\S]*音量已对齐[\s\S]*副歌 1 号更稳/);
  assert.match(await block.innerText(), oneIsB ? /整体：第 1 轮 B 更好/ : /整体：第 1 轮 A 更好/);
  const saved = (await s.call('GET', M + `/songs/${song.id}`)).body;
  assert.equal(saved.rounds[0].comparisons[0].winner, oneIsB ? 'right' : 'left', '盲听的 1 号按实际版本存');
  assert.equal(saved.bestVersionId, oneIsB ? vB : vA);

  // 独验 P3-1：出声的那一版先播完，两版一起停；按钮显示已暂停；空格只切换不出声；再播放两版从同一位置一起开始
  await root.getByRole('button', {name: '对比', exact: true}).click();
  const p2 = root.getByRole('region', {name: 'A/B 对比'});
  await p2.getByLabel('左边版本').selectOption(vA);
  await p2.getByLabel('右边版本').selectOption(vB);
  await p2.getByRole('button', {name: /听 第 1 轮 B/}).click(); // B 是较短的 6 秒那版
  await p2.getByRole('button', {name: '第二句'}).click(); // A 跳到 4.0 秒，B 跳到 5.0 秒
  await p2.getByRole('button', {name: '播放两版'}).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.sgm-compare audio')].every(a => a.paused), null, {timeout: 6000});
  assert.ok(await p2.getByRole('button', {name: '播放两版'}).isVisible(), '按钮显示已暂停');
  const stopped = await page.$$eval('.sgm-compare audio', list => list.map(a => ({paused: a.paused, t: a.currentTime})));
  assert.ok(stopped.every(x => x.paused), '两版都停了，没有一版在静音地继续走');
  await page.keyboard.press('Space');
  await page.waitForTimeout(400);
  assert.ok((await page.$$eval('.sgm-compare audio', list => list.map(a => a.paused))).every(Boolean), '空格只切换，不会让静音的那版出声');
  await p2.getByRole('button', {name: '播放两版'}).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.sgm-compare audio')].every(a => !a.paused && a.currentTime > 0.3), null, {timeout: 6000});
  const restarted = await page.$$eval('.sgm-compare audio', list => list.map(a => a.currentTime));
  assert.ok(Math.abs(restarted[0] - restarted[1]) < 0.3 && restarted[0] < 2, `两版从同一位置一起开始：${restarted}`);
  await p2.getByRole('button', {name: '暂停两版'}).click();

  // 独验 P3-2：盲听时只说「已对齐音量」，不说调了哪一号、调了多少；揭晓后才显示
  await p2.getByRole('button', {name: '盲听'}).click();
  const blindHint = await p2.locator('.sgm-hint').first().innerText();
  assert.match(blindHint, /已对齐音量/);
  assert.doesNotMatch(blindHint, /dB|调低|[12] 号/, `盲听提示不露出谁更响：${blindHint}`);

  // 独验 info：盲听时播放只走到较短那一版的长度，到点两版一起停，两条进度条同时走满、时间相同
  const bar = p2.locator('.sgm-neutral-bar').first(), box = await bar.boundingBox();
  await page.mouse.click(box.x + box.width * 0.93, box.y + box.height / 2);
  await p2.getByRole('button', {name: '播放两版'}).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.sgm-compare audio')].every(a => a.paused), null, {timeout: 6000});
  const ends = await page.$$eval('.sgm-compare audio', list => list.map(a => a.currentTime));
  assert.ok(Math.abs(ends[0] - ends[1]) < 0.05 && Math.abs(ends[0] - 6) < 0.3, `盲听停在较短那版的长度、两版同一位置：${ends}`);
  const times = await p2.locator('.sgm-compare-track .sgm-version-time').allInnerTexts();
  assert.equal(times[0], times[1], `盲听时两版显示同样的时间：${times}`);
  assert.deepEqual(await p2.locator('.sgm-neutral-bar > span').evaluateAll(list => list.map(el => el.style.width)), ['100%', '100%']);
  await p2.getByRole('button', {name: '揭晓'}).click();
  assert.match(await p2.locator('.sgm-hint').first().innerText(), /调低 \d+\.\d dB/, '揭晓后显示具体数字');
  await p2.getByRole('button', {name: '返回'}).click();

  // 选中状态与实心按钮：四种配色加深色主题，在悬停过渡结束后对比度都要 ≥ 4.5
  for (const [palette, theme] of [['follow', 'forest'], ['paper', 'forest'], ['studio', 'forest'], ['gallery', 'forest'], ['follow', 'dark']]) {
    await page.evaluate(([p, t]) => { localStorage.setItem('shiguang.musicPalette.v1', p); localStorage.setItem('shiguang.theme', t); }, [palette, theme]);
    await page.reload();
    await root.getByRole('button', {name: '对比', exact: true}).click();
    const cmp = root.getByRole('region', {name: 'A/B 对比'});
    for (const blindMode of [false, true]) {
      if (blindMode) await cmp.getByRole('button', {name: '盲听'}).click();
      await cmp.locator('[role=radio][aria-checked=false]').first().click(); // 再点已选中的会取消选择
      if (!blindMode) await cmp.getByRole('button', {name: '在当前位置打点'}).click();
      await page.mouse.move(2, 2);
      await page.waitForTimeout(300);
      assert.equal(await cmp.locator('[role=radio][aria-checked=true]').count(), 1);
      const bad = await lowContrast(page, '.sgm-compare .sgm-choice, .sg-music .sgm-btn.primary, .sg-music .sgm-pill.accent, .sgm-marker-jump, .sgm-compare-badge, .sgm-compare-track.is-active .sgm-version-time, .sgm-compare-track.is-active .sgm-compare-side small', 4.5);
      assert.deepEqual(bad, [], `${palette}/${theme}${blindMode ? ' 盲听' : ''} 选中或实心按钮看不清`);
    }
    await cmp.getByRole('button', {name: '返回'}).click();
  }
  assert.deepEqual(errors, []);
});
