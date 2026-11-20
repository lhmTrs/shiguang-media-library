// 项目音乐 ·「文件」区（PR4，SPEC 第十三节）：真实服务 + 全新临时库 + 合成音频。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {tempDirectories} from './helpers/temp-cleanup.mjs';
import {startServer, synth} from './helpers/project-music-server.mjs';

const makeTemp = tempDirectories(test, 'sg-project-music-files-');
const uuid = () => crypto.randomUUID();
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

async function put(s, F, folder, file, name = path.basename(file)) {
  const bytes = await fs.readFile(file), requestId = uuid();
  const start = await s.call('POST', F + '/imports', {requestId, folder, fileName: name, bytes: bytes.length}, {asPage: true});
  assert.equal(start.status, 200, start.text);
  const body = await s.call('PUT', F + `/imports/${requestId}/content`, bytes);
  return {requestId, ...body, bytes};
}

test('项目音乐 · 文件区：建文件夹、上传、同内容先问、波形、下载、改名后音乐库记录跟着走、加入歌曲、桌面操作只限页面', async t => {
  const base = await makeTemp(t);
  const audio = path.join(base, 'audio');
  await fs.mkdir(audio);
  const a = await synth(audio, 'Suno下载甲.mp3', {freq: 330}), b = await synth(audio, '剪辑版.wav', {freq: 550});
  const s = await startServer(t, base);
  const pid = (await s.call('POST', '/projects', {name: '合成文件项目'})).body.id;
  const M = `/project-music/projects/${pid}`, F = M + '/files';
  const projectDir = path.join(s.personal, 'music', `合成文件项目--${pid}`);

  // 还没有文件夹：显示空，同时有「歌曲」入口
  let view = (await s.call('GET', F)).body;
  assert.equal(view.exists, false);
  assert.equal(view.songs.id, '歌曲');
  assert.deepEqual(view.items, []);

  // 建文件夹：保留名「歌曲」、重名（不分大小写）、非法名字都拒绝
  view = (await s.call('POST', F + '/folders', {parent: '', name: 'Suno下载'})).body;
  assert.equal(view.folder, 'Suno下载');
  assert.deepEqual(view.folders.map(f => [f.id, f.parentId]), [['Suno下载', 'root']]);
  await fs.access(path.join(projectDir, 'Suno下载'));
  assert.equal((await s.call('POST', F + '/folders', {parent: '', name: '歌曲'})).body.code, 'FOLDER_RESERVED');
  assert.equal((await s.call('POST', F + '/folders', {parent: '', name: 'suno下载'})).body.code, 'FOLDER_EXISTS');
  assert.equal((await s.call('POST', F + '/folders', {parent: '', name: '../外面'})).body.code, 'INVALID_FOLDER_NAME');
  assert.equal((await s.call('GET', F + '?folder=' + encodeURIComponent('../x'))).body.code, 'INVALID_PATH');
  assert.equal((await s.call('GET', F + '?folder=' + encodeURIComponent('不存在'))).status, 404);

  // 上传到文件夹：立即登记进音乐库「AI生成」，主类是项目、子类是文件夹
  const up = await put(s, F, 'Suno下载', a);
  assert.equal(up.status, 200, up.text);
  assert.equal(up.body.status, 'ready');
  assert.equal(up.body.path, 'Suno下载/Suno下载甲.mp3');
  assert.equal((await s.call('POST', F + '/imports', {requestId: uuid(), folder: '歌曲', fileName: 'x.mp3', bytes: 10}, {asPage: true})).body.code, 'FOLDER_RESERVED');
  assert.equal((await s.call('POST', F + '/imports', {requestId: uuid(), folder: '', fileName: 'x.mp4', bytes: 10}, {asPage: true})).body.code, 'UNSUPPORTED_FORMAT');
  view = (await s.call('GET', F + '?folder=' + encodeURIComponent('Suno下载'))).body;
  const item = view.items[0];
  assert.equal(item.name, 'Suno下载甲.mp3');
  assert.equal(item.audio, true);
  assert.equal(item.addable, true);
  assert.equal(item.inLibrary, true);
  const asset = (await s.call('GET', `/assets/${item.assetId}`)).body;
  assert.equal(asset.category, `合成文件项目--${pid}`);
  assert.equal(asset.sub, 'Suno下载');
  assert.ok(!JSON.stringify(view).includes(s.personal), '不暴露本机路径');
  assert.equal(view.folders.find(f => f.id === 'Suno下载').count, 1);

  // 同一个文件夹里已有同内容：先问；取消不留东西，仍然保留就按「名字-2」另存
  const dup = await put(s, F, 'Suno下载', a);
  assert.equal(dup.body.status, 'duplicate');
  assert.deepEqual(dup.body.duplicates, ['Suno下载甲.mp3']);
  assert.equal((await s.call('POST', F + `/imports/${dup.requestId}/resolve`, {choice: 'cancel'})).body.status, 'cancelled');
  const dup2 = await put(s, F, 'Suno下载', a);
  const kept = await s.call('POST', F + `/imports/${dup2.requestId}/resolve`, {choice: 'keep'});
  assert.equal(kept.body.status, 'ready', kept.text);
  assert.equal(kept.body.name, 'Suno下载甲-2.mp3');
  assert.equal((await s.call('GET', M + `/imports/${dup2.requestId}`)).status, 404, '歌曲回执接口查不到文件区的回执');

  // 波形（缓存）、下载、Range
  const peaks = await s.call('GET', F + '/peaks?path=' + encodeURIComponent(item.id));
  assert.equal(peaks.status, 200, peaks.text);
  assert.equal(peaks.body.peaks.length, 300);
  assert.ok(peaks.body.durationMs > 1500);
  assert.deepEqual((await s.call('GET', F + '/peaks?path=' + encodeURIComponent(item.id))).body, peaks.body);
  const got = await s.call('GET', F + '/media?download=1&path=' + encodeURIComponent(item.id), undefined, {raw: true});
  assert.equal(sha(Buffer.from(await got.arrayBuffer())), sha(up.bytes));
  assert.match(decodeURIComponent(got.headers.get('content-disposition').split("UTF-8''")[1]), /^Suno下载甲\.mp3$/);
  const part = await s.call('GET', F + '/media?path=' + encodeURIComponent(item.id), undefined, {raw: true, headers: {range: 'bytes=0-9'}});
  assert.equal(part.status, 206);
  assert.equal((await s.call('GET', F + '/media?path=' + encodeURIComponent('../../x.mp3'))).body.code, 'INVALID_PATH');

  // 改名：磁盘改名，音乐库里的记录路径和子类跟着改，素材 ID 和你加的标签不变
  await s.call('PATCH', `/assets/${item.assetId}`, {tags: ['我加的']});
  await s.call('POST', F + '/folders', {parent: 'Suno下载', name: '第一批'});
  const inner = await put(s, F, 'Suno下载/第一批', b);
  assert.equal(inner.body.status, 'ready', inner.text);
  assert.equal((await s.call('POST', F + '/folders/rename', {path: '', name: 'x'})).body.code, 'FOLDER_RESERVED', '项目文件夹本身不能改名');
  assert.equal((await s.call('POST', F + '/folders/rename', {path: '歌曲', name: 'x'})).body.code, 'FOLDER_RESERVED');
  view = (await s.call('POST', F + '/folders/rename', {path: 'Suno下载', name: 'Suno 下载合集'})).body;
  assert.equal(view.folder, 'Suno 下载合集');
  assert.deepEqual(view.folders.map(f => f.id).sort(), ['Suno 下载合集', 'Suno 下载合集/第一批']);
  const moved = (await s.call('GET', `/assets/${item.assetId}`)).body;
  assert.equal(moved.path, path.join(await fs.realpath(projectDir), 'Suno 下载合集', 'Suno下载甲.mp3'));
  assert.equal(moved.sub, 'Suno 下载合集');
  assert.deepEqual(moved.tags, ['我加的']);
  const innerAsset = (await s.call('GET', F + '?folder=' + encodeURIComponent('Suno 下载合集/第一批'))).body.items[0];
  assert.equal(innerAsset.inLibrary, true, '子文件夹里的记录也跟着改了');

  // 访达或 AI 直接放进来的文件：还没登记也能列出、播放；加入歌曲时登记并复用这条记录，文件不挪
  await fs.mkdir(path.join(projectDir, 'AI剪辑'));
  await fs.copyFile(b, path.join(projectDir, 'AI剪辑', '剪好的.wav'));
  view = (await s.call('GET', F + '?folder=AI剪辑')).body;
  assert.equal(view.items[0].inLibrary, false);
  let song = (await s.call('POST', M + '/songs', {requestId: uuid(), title: '合成歌'}, {asPage: true})).body;
  song = (await s.call('POST', M + `/songs/${song.id}/rounds`, {requestId: uuid(), prompt: {tool: '本地模型', style: '合成'}}, {asPage: true})).body;
  const round = song.rounds[0];
  const addReq = uuid();
  const added = await s.call('POST', F + '/add-to-song', {requestId: addReq, path: 'AI剪辑/剪好的.wav', roundId: round.id}, {asPage: true});
  assert.equal(added.status, 200, added.text);
  const v = added.body.rounds[0].versions[0];
  assert.equal(v.label, '剪好的', '本地模型按文件名起版本名');
  assert.equal(v.library.reused, true);
  assert.equal(v.library.sub, 'AI剪辑');
  assert.equal((await s.call('POST', F + '/add-to-song', {requestId: addReq, path: 'AI剪辑/剪好的.wav', roundId: round.id}, {asPage: true})).body.rounds[0].versions.length, 1, '同一请求重放');
  await fs.access(path.join(projectDir, 'AI剪辑', '剪好的.wav'));
  view = (await s.call('GET', F + '?folder=AI剪辑')).body;
  assert.deepEqual(view.items[0].inSongs.map(x => [x.songTitle, x.roundNo, x.label]), [['合成歌', 1, '剪好的']]);
  // 同内容已在项目里（子文件夹里的那份就是同一首）：先拦，带 keep 才加
  const again = await s.call('POST', F + '/add-to-song', {requestId: uuid(), path: 'Suno 下载合集/第一批/剪辑版.wav', roundId: round.id}, {asPage: true});
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'DUPLICATE_IN_PROJECT');
  const keep = await s.call('POST', F + '/add-to-song', {requestId: uuid(), path: 'Suno 下载合集/第一批/剪辑版.wav', roundId: round.id, keep: true}, {asPage: true});
  assert.equal(keep.status, 200, keep.text);
  const media = await s.call('GET', M + `/versions/${v.id}/media`, undefined, {raw: true});
  assert.equal(sha(Buffer.from(await media.arrayBuffer())), sha(await fs.readFile(b)));
  // 在访达里把含「已加入歌曲」文件的文件夹挪走（等同删掉）：版本标「文件不在原位置」，写出原来的位置；放回原处就恢复
  await fs.rename(path.join(projectDir, 'AI剪辑'), path.join(base, '挪走的AI剪辑'));
  let gone = (await s.call('GET', M + `/songs/${song.id}`)).body.rounds[0].versions.find(x => x.id === v.id);
  assert.equal(gone.library.offline, true);
  assert.equal(gone.library.place, '项目音乐 › AI剪辑 / 剪好的.wav');
  assert.ok(!JSON.stringify(gone.library).includes(s.personal), '不暴露本机路径');
  await fs.rename(path.join(base, '挪走的AI剪辑'), path.join(projectDir, 'AI剪辑'));
  gone = (await s.call('GET', M + `/songs/${song.id}`)).body.rounds[0].versions.find(x => x.id === v.id);
  assert.equal(gone.library.offline, false);

  // 歌曲上传以后「歌曲」文件夹出现（作为系统入口单独给出）；在访达里把它挪走，页面提示核对
  view = (await s.call('GET', F)).body;
  assert.equal(view.songs.songCount, 1);
  assert.equal(view.songs.present, false, '加入歌曲的版本复用文件区的文件，还没有「歌曲」文件夹');
  // 让「歌曲」里有一个真正的新文件
  const c = await synth(audio, '丙.mp3', {freq: 770}), cb = await fs.readFile(c), cid = uuid();
  await s.call('POST', M + '/imports', {requestId: cid, roundId: round.id, fileName: '丙.mp3', bytes: cb.length}, {asPage: true});
  assert.equal((await s.call('PUT', M + `/imports/${cid}/content`, cb)).body.status, 'ready');
  view = (await s.call('GET', F)).body;
  assert.equal(view.songs.present, true);
  assert.equal(view.folders.some(f => f.id === '歌曲'), false, '不混在用户文件夹里');
  await fs.rename(path.join(projectDir, '歌曲'), path.join(projectDir, '歌曲（挪过）'));
  view = (await s.call('GET', F)).body;
  assert.equal(view.songs.present, false);
  assert.equal(view.songs.needsReview, true);

  // 桌面操作：本测试关掉了原生组件 → 说明不可用；没有页面标记一律拒绝
  const caps = (await s.call('GET', F + '/desktop')).body;
  assert.equal(caps.clipboard.available, false);
  assert.equal((await s.call('POST', F + '/clipboard', {requestId: uuid(), paths: [item.id]})).body.code, 'PAGE_ONLY');
  assert.equal((await s.call('POST', F + '/clipboard', {requestId: uuid(), paths: ['Suno 下载合集/Suno下载甲.mp3']}, {asPage: true})).body.code, 'DESKTOP_UNAVAILABLE');
});

test('项目音乐 · 文件区：复制给剪辑软件、在访达中显示走生成视频的原生组件，核对身份，同一请求只执行一次', async t => {
  const {Library} = await import('../server/library.mjs');
  const {MysqlStorage} = await import('../server/mysql.mjs');
  const {Projects} = await import('../server/projects.mjs');
  const {ProjectMusic} = await import('../server/project-music/store.mjs');
  const {MusicFolders} = await import('../server/project-music/folders.mjs');
  const base = await fs.realpath(await makeTemp(t));
  const app = path.join(base, 'app');
  await fs.mkdir(app);
  const storage = await new MysqlStorage(app).init();
  const lib = await new Library(app, {directoryClassification: true}).init();
  storage.attach(lib);
  t.after(() => lib.db.close());
  const projects = new Projects(lib).init();
  const p = projects.save(null, {name: '合成桌面项目'});
  const store = new ProjectMusic({lib, projects, dataDir: app, directory: path.join(base, 'personal_item', 'music'), autoMigrate: false}).init();
  t.after(() => store.close());
  const calls = [];
  let changeCount = 7;
  const native = {
    capabilities: async () => ({clipboard: {available: true}, revealMany: {available: true}}),
    clipboardVersion: async () => changeCount,
    copyFiles: async (paths, {expectedChangeCount, beforeDispatch}) => { await beforeDispatch(); calls.push(['copy', paths, expectedChangeCount]); return {ack: 'written', count: paths.length, changeCount: ++changeCount}; },
    revealFiles: async (paths, {beforeDispatch}) => { await beforeDispatch(); calls.push(['reveal', paths]); return {ack: 'dispatched', count: paths.length}; },
    openFolder: async (folder, {identity}) => { calls.push(['open', folder, identity]); return {ack: 'dispatched'}; },
  };
  const folders = new MusicFolders(store, {native, dataDir: app});
  await folders.createFolder(p.id, {parent: '', name: '交给剪辑'});
  const dir = path.join(base, 'personal_item', 'music', `合成桌面项目--${p.id}`, '交给剪辑');
  await synth(dir, '一.mp3', {freq: 300});
  await synth(dir, '二.mp3', {freq: 400});
  const req = uuid();
  const copied = await folders.clipboard(p.id, {requestId: req, paths: ['交给剪辑/一.mp3', '交给剪辑/二.mp3']});
  assert.deepEqual(copied, {status: 'completed', count: 2, ack: 'written'});
  assert.deepEqual(calls[0], ['copy', [path.join(dir, '一.mp3'), path.join(dir, '二.mp3')], 7]);
  assert.deepEqual(await folders.clipboard(p.id, {requestId: req, paths: ['交给剪辑/一.mp3', '交给剪辑/二.mp3']}), copied, '同一请求不再复制一次');
  assert.equal(calls.length, 1);
  // 核对后文件被改：不复制
  native.copyFiles = async (paths, {beforeDispatch}) => { await fs.appendFile(path.join(dir, '一.mp3'), 'x'); await beforeDispatch(); return {ack: 'written', count: paths.length}; };
  await assert.rejects(() => folders.clipboard(p.id, {requestId: uuid(), paths: ['交给剪辑/一.mp3']}), e => e.code === 'PREVIEW_STALE');
  await folders.reveal(p.id, {requestId: uuid(), paths: ['交给剪辑/二.mp3']});
  assert.deepEqual(calls.at(-1), ['reveal', [path.join(dir, '二.mp3')]]);
  await folders.reveal(p.id, {requestId: uuid(), folder: '交给剪辑'});
  const st = await fs.lstat(dir);
  assert.deepEqual(calls.at(-1), ['open', dir, {dev: String(st.dev), ino: String(st.ino)}]);
  await assert.rejects(() => folders.clipboard(p.id, {requestId: uuid(), paths: []}), e => e.code === 'FILE_SELECTION_INVALID');
});

test('项目音乐 · 文件区：你在文件区给一首歌打的标签，加入歌曲后改风格也不会被删（验收 PR4 附 P2-1）', async t => {
  const base = await makeTemp(t);
  const audio = path.join(base, 'audio');
  await fs.mkdir(audio);
  const a = await synth(audio, 'a.mp3', {freq: 345});
  const s = await startServer(t, base);
  const pid = (await s.call('POST', '/projects', {name: '合成钢琴项目'})).body.id;
  const M = `/project-music/projects/${pid}`, F = M + '/files';
  await s.call('POST', F + '/folders', {parent: '', name: 'Suno下载'});
  const up = await put(s, F, 'Suno下载', a);
  assert.equal(up.body.status, 'ready', up.text);
  const item = (await s.call('GET', F + '?folder=Suno下载')).body.items[0];
  await s.call('PATCH', `/assets/${item.assetId}`, {tags: ['钢琴']});
  let song = (await s.call('POST', M + '/songs', {requestId: uuid(), title: '合成钢琴曲'}, {asPage: true})).body;
  song = (await s.call('POST', M + `/songs/${song.id}/rounds`, {requestId: uuid(), prompt: {tool: '本地模型', style: '钢琴, 夜晚'}}, {asPage: true})).body;
  song = (await s.call('POST', F + '/add-to-song', {requestId: uuid(), path: item.id, roundId: song.rounds[0].id}, {asPage: true})).body;
  const settle = async () => {
    for (let i = 0; i < 400; i++) {
      const now = (await s.call('GET', M + `/songs/${song.id}`)).body;
      const v = now.rounds[0].versions[0];
      if (v.library.tagSync === 'done') return now;
      if (v.library.tagSync === 'failed') assert.fail(v.library.tagError);
      await new Promise(r => setTimeout(r, 25));
    }
    assert.fail('标签一直没写完');
  };
  song = await settle();
  let tags = (await s.call('GET', `/assets/${item.assetId}`)).body.tags;
  assert.ok(tags.includes('钢琴') && tags.includes('夜晚') && tags.includes('AI生成'), String(tags));
  const r = song.rounds[0];
  await s.call('PATCH', M + `/rounds/${r.id}`, {expectedRevision: r.revision, prompt: {...r.prompt, style: '流行'}}, {asPage: true});
  song = await settle();
  tags = (await s.call('GET', `/assets/${item.assetId}`)).body.tags;
  assert.ok(tags.includes('钢琴'), '你在文件区打的「钢琴」不能被删：' + tags);
  assert.ok(!tags.includes('夜晚') && tags.includes('流行'), String(tags));
});
