// 待处理测试共用：在还没启动的临时数据目录里，预先放一首合成歌，让它的第 1 轮处于「待 AI 补写」。
// 做法和访达收纳开新一轮相同（ProjectMusic.createRound 的 fromIntake），不用音频，不碰真实库。
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Library} from '../../server/library.mjs';
import {Projects} from '../../server/projects.mjs';
import {ProjectMusic} from '../../server/project-music/store.mjs';

export async function seedPendingRound(base, {projectName = '合成项目', songTitle = '合成歌曲'} = {}) {
  const data = path.join(base, 'data'), personal = path.join(base, 'personal_item');
  await fs.mkdir(data, {recursive: true}); await fs.mkdir(personal, {recursive: true});
  const prev = {skip: process.env.MEDIA_SKIP_IMPORT, reconcile: process.env.MEDIA_SKIP_RECONCILE, watch: process.env.MEDIA_NO_WATCH};
  process.env.MEDIA_SKIP_IMPORT = '1'; process.env.MEDIA_SKIP_RECONCILE = '1'; process.env.MEDIA_NO_WATCH = '1';
  const lib = await new Library(data, {directoryClassification: true}).init();
  try {
    const projects = new Projects(lib).init();
    const music = new ProjectMusic({lib, projects, dataDir: data, directory: path.join(personal, 'music'), autoMigrate: false}).init();
    const p = projects.save(null, {name: projectName});
    const page = {kind: 'user', at: Date.now()};
    let song = music.createSong(p.id, {requestId: randomUUID(), title: songTitle}, page);
    song = music.createRound(p.id, song.id, {requestId: randomUUID(), prompt: {tool: 'Suno', style: '合成风格', lyrics: '一\n二'}}, page);
    song = music.createRound(p.id, song.id, {requestId: randomUUID()}, page, {fromIntake: true});
    await music.close();
    return {projectId: p.id, songId: song.id, roundId: song.rounds[0].id, round: song.rounds[0]};
  } finally {
    lib.db.close();
    for (const [k, v] of [['MEDIA_SKIP_IMPORT', prev.skip], ['MEDIA_SKIP_RECONCILE', prev.reconcile], ['MEDIA_NO_WATCH', prev.watch]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}
