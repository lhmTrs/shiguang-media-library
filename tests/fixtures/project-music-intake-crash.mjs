// 子进程：一批 3 个文件收进项目音乐，在第 2 个文件的某一步把自己 SIGKILL（模拟进程被杀）。
// 用法：node project-music-intake-crash.mjs <目录> <before-publish|after-publish|after-register> <song|files>
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openIntakeFixture} from '../helpers/project-music-intake-fixture.mjs';
import {synth} from '../helpers/project-music-server.mjs';

const [dir, stage, target] = process.argv.slice(2);
const f = await openIntakeFixture(dir);
const project = f.projects.save(null, {name: '合成中断项目'});
await f.folders.createFolder(project.id, {parent: '', name: 'Suno下载'});
const audio = path.join(dir, '下载');
await fs.mkdir(audio, {recursive: true});
const files = [await synth(audio, '一.mp3', {freq: 300}), await synth(audio, '二.mp3', {freq: 400}), await synth(audio, '三.mp3', {freq: 500})];
const d = target === 'song' ? {kind: 'music', scope: 'project', projectId: project.id, newSongTitle: '中断歌', newRound: true} : {kind: 'music', scope: 'project', projectId: project.id, musicFolder: 'Suno下载'};
const die = () => process.kill(process.pid, 'SIGKILL');
let publishes = 0, registers = 0;
const publish = f.store.files.publish.bind(f.store.files);
f.store.files.publish = async (...args) => {
  publishes++;
  if (stage === 'before-publish' && publishes === 2) die();
  const placed = await publish(...args);
  if (stage === 'after-publish' && publishes === 2) die();
  return placed;
};
f.lib.enqueue = () => { registers++; if (stage === 'after-register' && registers === 2) die(); };
const h = await f.intake.receipts.handoff(files);
const input = {version: 2, requestId: randomUUID(), mode: 'copy', fileIds: h.files.map(x => x.id), targets: h.files.map(x => ({fileId: x.id, destination: d}))};
await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({projectId: project.id, batchId: input.requestId}));
await f.intake.confirm(h.id, input);
await new Promise(r => setTimeout(r, 30000));
console.error('没有在预期的位置中断');
process.exit(3);
