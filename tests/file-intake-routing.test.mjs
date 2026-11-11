// Pure routing suggestions for the simple intake window. Synthetic names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {suggest, suggestAll, audioKindFor, isGenericName, longestPrefix, batchProject} from '../src/file-intake/routing.mjs';

const P1 = 'p1', P2 = 'p2', P3 = 'p3';
const options = {
  projects: [
    {id: P1, name: '穿越计', videoFolders: [{id: 'root', name: '项目根目录', relativePath: ''}, {id: 'f-out', name: '外景', relativePath: '外景'}, {id: 'f-outn', name: '外景夜', relativePath: '外景夜'}],
      assets: [
        {id: 'c-aq', kind: 'character', name: '阿青', revision: 3, defaultLookId: 'l-day', looks: [{id: 'l-day', name: '日常', revision: 1}, {id: 'l-swim', name: '泳衣', revision: 2}]},
        {id: 's-street', kind: 'scene', name: '雨夜街口', revision: 5, defaultLookId: null, looks: []},
        {id: 'p-watch', kind: 'prop', name: '怀表', revision: 1, defaultLookId: null, looks: []},
      ]},
    {id: P2, name: '穿越', videoFolders: [{id: 'root', name: '项目根目录', relativePath: ''}], assets: []},
    {id: P3, name: '雨巷', videoFolders: [{id: 'root', name: '项目根目录', relativePath: ''}, {id: 'f-yx', name: '第一场', relativePath: '第一场'}],
      assets: [{id: 'c-xm', kind: 'character', name: '小满', revision: 1, defaultLookId: null, looks: []}]},
  ],
  photoCategories: [{id: '', name: '待确认', relativePath: ''}, {id: '场景', name: '场景', relativePath: '场景'}, {id: '道具', name: '道具', relativePath: '道具'}],
};
const prefs = {lastProjectId: {photo: P1, video: P3}, lastVideoFolderByProject: {[P1]: 'f-out', [P3]: 'f-yx'}, lastLibraryDirectory: {photo: '', video: '', music: '', sfx: ''}, lastAudioKind: null, mode: 'copy', standardNames: false};
const v = name => ({id: name, name, mediaKind: 'video', bytes: 1, path: '/s/' + name});
const ph = name => ({id: name, name, mediaKind: 'photo', bytes: 1, path: '/s/' + name});
const au = (name, durationSec) => ({id: name, name, mediaKind: 'audio', bytes: 1, path: '/s/' + name, durationSec});
const lib = ({kind, scope, directory}) => ({kind, scope, directory});
const one = (file, extra = {}) => suggest(file, {options, prefs: {...prefs, ...extra}, batch: null});

test('longest project prefix wins and needs no separator', () => {
  assert.equal(longestPrefix(options.projects, '穿越计视频16').id, P1);
  assert.equal(longestPrefix(options.projects, '穿越者').id, P2);
  assert.equal(longestPrefix(options.projects, 'canvas_8f2a'), null);
});

test('video: project prefix, then that project\'s last folder', () => {
  const s = one(v('穿越计视频16.mp4'));
  assert.deepEqual(s.destination, {kind: 'video', scope: 'project', projectId: P1, folderId: 'f-out'});
  assert.match(s.reason, /文件夹沿用上次/);
});

test('video: folder name after project wins, longest folder', () => {
  assert.equal(one(v('穿越计_外景夜_3.mp4')).destination.folderId, 'f-outn');
  assert.equal(one(v('穿越计 外景 3.mp4')).destination.folderId, 'f-out');
});

test('video: recognized project never used before goes to its root', () => {
  assert.equal(one(v('穿越 预告.mp4')).destination.folderId, 'root');
});

test('video: unrecognized follows last project and folder; stale folder falls back to root', () => {
  assert.deepEqual(one(v('canvas_8f2a.mp4')).destination, {kind: 'video', scope: 'project', projectId: P3, folderId: 'f-yx'});
  assert.equal(one(v('canvas_8f2a.mp4'), {lastVideoFolderByProject: {[P3]: 'gone'}}).destination.folderId, 'root');
});

test('video: no valid project at all goes to 视频素材 待确认', () => {
  const s = one(v('x.mp4'), {lastProjectId: {photo: null, video: 'archived'}});
  assert.deepEqual(s.destination, {kind: 'video', scope: 'library', directory: ''});
});

test('photo priority 1: scene and prop before characters', () => {
  const s = one(ph('雨夜街口_02.png'));
  assert.deepEqual(s.destination, {kind: 'photo', scope: 'project', projectId: P1, assetKind: 'scene', assetId: 's-street', assetRevision: 5});
  assert.equal(one(ph('怀表 特写.png')).destination.assetKind, 'prop');
});

test('photo priority 2: existing character with existing or new look', () => {
  assert.deepEqual(one(ph('阿青_泳衣.png')).destination, {kind: 'photo', scope: 'project', projectId: P1, characterName: '阿青', lookName: '泳衣'});
  const fresh = one(ph('阿青_雨夜风衣.png'));
  assert.equal(fresh.destination.lookName, '雨夜风衣'); assert.match(fresh.reason, /将新建造型/);
  assert.equal(one(ph('阿青.png')).destination.lookName, '日常');
});

test('photo priority 3: new character is a decision, never automatic', () => {
  const s = one(ph('小雨_校服.png'));
  assert.equal(s.group, 'decide'); assert.equal(s.decision, 'new-character'); assert.equal(s.reason, '项目里还没有这个人物');
  assert.equal(s.destination.characterName, '小雨');
});

test('photo: generic platform names never become new characters', () => {
  for (const name of ['canvas_a81c.png', 'IMG_0844.HEIC', 'image_0931.png', 'output_1731.jpg', '下载_3.png', 'Screenshot_1.png'])
    assert.equal(one(ph(name)).decision, undefined, name);
  assert.ok(isGenericName('canvas_a81c.png')); assert.ok(!isGenericName('canvasman_日常.png'));
});

test('photo priority 4 and 5: category prefix, then 待确认', () => {
  assert.deepEqual(lib(one(ph('场景天台.png')).destination), {kind: 'photo', scope: 'library', directory: '场景'});
  // Agreed order asks about a possible new character first and offers the category as the other answer.
  const both = one(ph('场景_天台.png'));
  assert.equal(both.decision, 'new-character'); assert.deepEqual(both.alternative, {directory: '场景', name: '场景'});
  assert.deepEqual(lib(one(ph('image_0931.png')).destination), {kind: 'photo', scope: 'library', directory: ''});
  assert.equal(one(ph('苏禾_日常.png'), {lastProjectId: {photo: null, video: null}}).destination.characterName, '苏禾', 'library photo keeps the name guess for the editor');
});

test('photo: project prefix switches project only when the rest matches', () => {
  assert.equal(one(ph('雨巷小满_校服.png'), {lastProjectId: {photo: P1, video: P3}}).destination.projectId, P3);
  const s = one(ph('穿越计图片3.png'));
  assert.equal(s.destination.scope, 'library'); assert.match(s.hint, /穿越计/);
  // Review counterexample: project prefix + separator + unmatched rest must not become new character 「穿越计」.
  const t = one(ph('穿越计_天台.png'));
  assert.equal(t.destination.scope, 'library'); assert.equal(t.decision, undefined); assert.match(t.hint, /穿越计/);
  assert.equal(suggestAll([ph('穿越计_天台.png')], options, prefs)['穿越计_天台.png'].destination.scope, 'library');
});

test('photo follows the project this batch points at', () => {
  const files = [v('雨巷视频1.mp4'), v('雨巷视频2.mp4'), ph('小满.png')];
  assert.equal(batchProject(files, options).id, P3);
  const all = suggestAll(files, options, prefs);
  assert.equal(all['小满.png'].destination.projectId, P3);
  assert.equal(all['小满.png'].destination.characterName, '小满');
});

test('project bar forces the project for files whose name names none', () => {
  const files = [v('canvas_1.mp4'), ph('阿青_泳衣.png'), v('雨巷视频1.mp4'), ph('小满.png')];
  const all = suggestAll(files, options, prefs, P1);
  assert.deepEqual(all['canvas_1.mp4'].destination, {kind: 'video', scope: 'project', projectId: P1, folderId: 'f-out'}); assert.match(all['canvas_1.mp4'].reason, /跟随整批项目/);
  assert.equal(all['雨巷视频1.mp4'].destination.projectId, P3, 'a project named in the file name still wins');
  assert.equal(all['阿青_泳衣.png'].destination.projectId, P1);
  assert.equal(all['小满.png'].decision, undefined); assert.equal(all['小满.png'].destination.scope, 'library', '小满 is no character of 穿越计 and the name is not 人物_造型');
});

test('audio presets by duration with inclusive 60–120 middle band', () => {
  assert.equal(audioKindFor(59.9, null).kind, 'sfx');
  assert.equal(audioKindFor(60, null).kind, 'music');
  assert.equal(audioKindFor(60, 'sfx').kind, 'sfx');
  assert.equal(audioKindFor(120, 'sfx').kind, 'sfx');
  assert.equal(audioKindFor(120.1, 'sfx').kind, 'music');
  assert.equal(audioKindFor(null, 'sfx'), null);
  const s = one(au('雨声.wav', 42));
  assert.deepEqual(s.destination, {kind: 'sfx', scope: 'library', directory: ''}); assert.match(s.reason, /0:42/);
  assert.equal(one(au('x.m4a', null)).decision, 'audio-kind');
});
