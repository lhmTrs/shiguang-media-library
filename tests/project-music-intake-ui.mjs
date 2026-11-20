// 访达右键收纳 → 项目音乐（PR5）· 真实应用界面测试。先 npm run build；使用系统 Chrome、全新临时库、合成音频；不注册真实访达入口。
// 运行：node --test tests/project-music-intake-ui.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {chromium} from '@playwright/test';
import {tempDirectories} from './helpers/temp-cleanup.mjs';
import {repo, startServer, synth} from './helpers/project-music-server.mjs';
import {Receipts} from '../server/file-intake/files.mjs';

const makeTemp = tempDirectories(test, 'sg-project-music-intake-ui-');
const uuid = () => crypto.randomUUID();

test('收纳窗口 · 项目音乐：文件名认出歌就放进这首歌（默认新开一轮，可附提示词）；其他音乐可改放进「文件」的文件夹；下次默认回到那个文件夹', async t => {
  await fs.access(path.join(repo, 'dist', 'index.html')).catch(() => assert.fail('请先 npm run build'));
  const base = await makeTemp(t);
  const audio = path.join(base, 'audio');
  await fs.mkdir(audio);
  const s = await startServer(t, base);
  const pid = (await s.call('POST', '/projects', {name: '合成收纳界面'})).body.id;
  const M = `/project-music/projects/${pid}`;
  await s.call('POST', M + '/files/folders', {parent: '', name: 'Suno下载'});
  // 已有一首歌「麦田」，第 1 轮已有一个版本 → 认出时默认新开一轮
  let song = (await s.call('POST', M + '/songs', {requestId: uuid(), title: '麦田'}, {asPage: true})).body;
  song = (await s.call('POST', M + `/songs/${song.id}/rounds`, {requestId: uuid(), prompt: {tool: 'Suno', style: '第一轮风格'}}, {asPage: true})).body;
  {
    const f = await synth(audio, '第一轮.mp3', {freq: 300}), bytes = await fs.readFile(f), rid = uuid();
    await s.call('POST', M + '/imports', {requestId: rid, roundId: song.rounds[0].id, fileName: '第一轮.mp3', bytes: bytes.length}, {asPage: true});
    assert.equal((await s.call('PUT', M + `/imports/${rid}/content`, bytes)).body.status, 'ready');
  }
  const named = await synth(audio, '麦田 (1).mp3', {freq: 440, seconds: 3});
  const other = await synth(audio, '散曲.mp3', {freq: 550, seconds: 130});
  const receipts = await new Receipts(s.data).init();
  const handoff = await receipts.handoff([named, other]);

  const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, timeout: 30000});
  t.after(() => browser.close());
  const context = await browser.newContext({viewport: {width: 1200, height: 900}});
  context.setDefaultTimeout(20000);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const posts = [];
  page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/confirm')) posts.push(r.postDataJSON()); });
  await page.goto(s.origin + '/#/file-intake/' + handoff.id);
  await page.getByRole('heading', {name: '收纳素材到拾光'}).waitFor();
  const [fNamed, fOther] = handoff.files;

  // 认出歌：分组写着放进「麦田」新开一轮
  await page.getByRole('region', {name: /项目音乐 › 歌曲「麦田」 › 新开一轮/}).waitFor();
  const edit = async file => { await page.locator('[data-file-id="' + file.id + '"]').click(); return page.getByRole('dialog', {name: '收纳设置 ' + file.name, exact: true}); };
  let panel = await edit(fNamed);
  assert.equal(await panel.getByRole('group', {name: '音乐去处 ' + fNamed.id}).getByRole('button', {name: '项目音乐'}).getAttribute('aria-pressed'), 'true');
  assert.equal(await panel.getByLabel('目标轮次 ' + fNamed.id).inputValue(), '__new_round__');
  // 附本轮提示词（没有原生剪贴板时是空框，⌘V 粘贴）
  await panel.getByRole('button', {name: '粘贴提示词'}).click();
  await panel.getByLabel('提示词').fill('中国风流行 女声 中速');
  await panel.getByLabel('提示词').blur(); // 点别处收起，和视频收纳的提示词框一样
  await panel.getByText('上一轮的记录还没写完也可以开').waitFor();
  await panel.getByRole('button', {name: '完成', exact: true}).click();

  // 第二个文件：默认进音乐库；改成项目音乐 › 文件 › Suno下载
  panel = await edit(fOther);
  assert.equal(await panel.getByRole('group', {name: '音乐去处 ' + fOther.id}).getByRole('button', {name: '音乐库'}).getAttribute('aria-pressed'), 'true');
  await panel.getByRole('group', {name: '音乐去处 ' + fOther.id}).getByRole('button', {name: '项目音乐'}).click();
  await panel.getByLabel('目标项目 ' + fOther.id).selectOption(pid);
  assert.equal(await panel.getByRole('group', {name: '项目音乐里的位置 ' + fOther.id}).getByRole('button', {name: '文件'}).getAttribute('aria-pressed'), 'true');
  assert.equal(await panel.getByLabel('目标轮次 ' + fOther.id).count(), 0, '放进「文件」不选轮次');
  await panel.getByLabel('项目音乐文件夹 ' + fOther.id).selectOption('Suno下载');
  await panel.getByRole('button', {name: '完成', exact: true}).click();
  await page.getByRole('region', {name: /项目音乐 › 文件 › Suno下载/}).waitFor();

  await page.locator('.fi-confirm-button').click();
  await page.getByText('任务已接收，请在网页顶栏“文件任务”查看后续进度。').waitFor();
  assert.equal(posts.length, 1);
  const targets = posts[0].targets.map(t => t.destination);
  assert.deepEqual(targets[0], {kind: 'music', scope: 'project', projectId: pid, songId: song.id, newRound: true, roundPrompt: '中国风流行 女声 中速'});
  assert.deepEqual(targets[1], {kind: 'music', scope: 'project', projectId: pid, musicFolder: 'Suno下载'});
  assert.ok(posts[0].targets.every(t => t.nameMode === undefined), '「按项目改名」对音乐不生效');
  let batch;
  for (let i = 0; i < 300; i++) { batch = (await s.call('GET', '/file-intake/batches/' + posts[0].requestId)).body; if (!['queued', 'running'].includes(batch.status)) break; await new Promise(r => setTimeout(r, 50)); }
  assert.equal(batch.status, 'completed', JSON.stringify(batch));

  // 结果：第 2 轮 A（提示词照填），第 1 轮标「待 AI 补写」；散曲在「文件 › Suno下载」
  song = (await s.call('GET', M + `/songs/${song.id}`)).body;
  assert.equal(song.rounds.length, 2);
  assert.equal(song.rounds[1].prompt.style, '中国风流行 女声 中速');
  assert.deepEqual(song.rounds[1].versions.map(v => v.label), ['A']);
  assert.ok(song.rounds[0].pendingAgentNotes);
  const pending = (await s.call('GET', '/project-music/pending-notes')).body.items;
  assert.deepEqual(pending.map(p => [p.songTitle, p.roundNo]), [['麦田', 1]]);
  const files = (await s.call('GET', M + '/files?folder=Suno下载')).body;
  assert.deepEqual(files.items.map(i => i.name), ['散曲.mp3']);

  // 项目音乐页：第 1 轮显示「待 AI 补写」，第 2 轮的版本标「访达收纳」
  await page.evaluate(([lib, project]) => {
    localStorage.setItem('shiguang.projectLocation.v1:' + lib, JSON.stringify({projectId: project, recent: [project], lastInContainer: {}}));
    localStorage.setItem('shiguang.projectMusic.tab.v1', 'songs');
  }, [(await (await fetch(s.origin + '/api/session')).json()).instanceId, pid]);
  const musicPage = await context.newPage();
  musicPage.on('pageerror', e => errors.push(e.message));
  await musicPage.goto(s.origin + '/#/project-music');
  const root = musicPage.locator('section.sg-music');
  await root.locator('article[aria-label="第 1 轮"]').getByText('待 AI 补写').waitFor();
  await root.locator('article[aria-label="第 2 轮"]').getByText('访达收纳').waitFor();

  // 下一次：新的音乐默认回到上次的项目音乐文件夹
  const third = await synth(audio, '又一首.mp3', {freq: 660, seconds: 130});
  const h2 = await receipts.handoff([third]);
  const next = await context.newPage();
  next.on('pageerror', e => errors.push(e.message));
  await next.goto(s.origin + '/#/file-intake/' + h2.id);
  // 只有一个文件时是单文件布局：直接写收到哪里
  await next.getByText('合成收纳界面 › 项目音乐 › 文件 › Suno下载').waitFor();
  await next.getByText(/沿用上次的项目音乐文件夹/).waitFor();
  assert.deepEqual(errors, []);
});
