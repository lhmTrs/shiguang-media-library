// 项目音乐收纳测试共用：在给定目录上起（或重新打开）真实收纳模块 + 项目音乐。只用合成音频，废纸篓一律是假的。
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Library} from '../../server/library.mjs';
import {Projects} from '../../server/projects.mjs';
import {ProjectAssets} from '../../server/project-assets/store.mjs';
import {VideoMedia} from '../../server/storyboard-video/media.mjs';
import {ManagedIntakeCatalog} from '../../server/file-intake/media-catalog.mjs';
import {FileIntake} from '../../server/file-intake/store.mjs';
import {IntakePreferences} from '../../server/file-intake/preferences.mjs';
import {ProjectMusic} from '../../server/project-music/store.mjs';
import {MusicFolders} from '../../server/project-music/folders.mjs';
import {ProjectMusicIntake} from '../../server/project-music/intake.mjs';

export async function openIntakeFixture(dir) {
  const dataDir = path.join(dir, 'data');
  await fs.mkdir(dataDir, {recursive: true});
  const lib = await new Library(dataDir, {directoryClassification: true}).init(); lib.enqueue = () => {};
  const projects = new Projects(lib).init(), assets = new ProjectAssets(lib).init(), media = new VideoMedia();
  const catalog = {lib, media, db: lib.db};
  const generic = await new ManagedIntakeCatalog({catalog, assets, dataDir, directory: path.join(dir, 'personal_item')}).init();
  const store = new ProjectMusic({lib, projects, dataDir, directory: path.join(dir, 'personal_item', 'music'), autoMigrate: false}).init();
  const folders = new MusicFolders(store, {dataDir});
  const music = new ProjectMusicIntake(store, folders);
  const trashed = [];
  // 假废纸篓：只挪进测试目录自己的 .Trash，绝不碰 ~/.Trash。
  const trash = async file => { const to = path.join(dir, '.Trash', randomUUID() + path.extname(file)); await fs.mkdir(path.dirname(to), {recursive: true}); await fs.rename(file, to); trashed.push(file); return to; };
  const preferences = await new IntakePreferences({dataDir, libraryId: dataDir}).init();
  const intake = await new FileIntake({dataDir, catalog, projects, generic, music, trash, preferences}).init();
  const close = async () => { await intake.close(); await store.close(); await media.close(); lib.db.close(); };
  return {dir, dataDir, lib, projects, store, folders, music, intake, trashed, preferences, close};
}

export async function intakeSettled(intake, ms = 20000) {
  const deadline = Date.now() + ms;
  while (intake.work || intake.status().activeCount) {
    if (Date.now() > deadline) throw Error('收纳没有结束');
    await new Promise(r => setTimeout(r, 10));
  }
  if (intake.lastError) throw intake.lastError;
}

// 重启后等项目音乐把上次中断的收尾做完。
export async function recovered(store) {
  for (let i = 0; i < 500 && !store.recovery; i++) await new Promise(r => setTimeout(r, 10));
  await store.recovery;
}
