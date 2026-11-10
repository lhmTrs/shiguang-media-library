import test from 'node:test';
import assert from 'node:assert/strict';
import {imageNamePreset, readImportTarget, rememberImportTarget, classificationParent} from '../src/import-presets.mjs';

test('人物只按第一个下划线拆分，造型后半段完整保留，不凭字数改变目标', () => {
  assert.deepEqual(imageNamePreset('杨卓_浪客剑心_三视图.png'), {name: '杨卓', lookName: '浪客剑心_三视图', structured: true, generated: false});
  assert.equal(imageNamePreset('很长的人物名称'.repeat(8) + '_长造型.png').structured, true);
  assert.equal(imageNamePreset('同名_默认_0.png').lookName, '默认_0');
  for (const file of ['杨卓.png', '杨卓_.jpg', '_造型.webp']) assert.equal(imageNamePreset(file).structured, false);
  assert.equal(imageNamePreset('城门_全景.png', 'scene').name, '城门_全景');
  assert.equal(imageNamePreset('佩刀_刀鞘.png', 'prop').name, '佩刀_刀鞘');
});
test('相机名、长随机编号不自动变成人物；普通名称只作可修改建议', () => {
  for (const file of ['IMG_20261110_123456.jpg', 'DSC_0012.jpg', 'PXL_20261110_造型.png', '20261110123000.png', 'a0b1c2d3e4f56789a0b1c2d3.png', '12ab3456-1234-4567-8901-123456789abc.png']) {
    assert.equal(imageNamePreset(file).generated, true, file);
    assert.equal(imageNamePreset(file).name, '', file);
    assert.equal(imageNamePreset(file).structured, false, file);
  }
  assert.equal(imageNamePreset('陈川.png').name, '陈川');
});
const memory = () => {const values = new Map(); return {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values};};
test('确认目标按素材库和图片/视频独立记忆，不记移除原件或提交编号', () => {
  const storage = memory(), projects = [{id: 'p1'}, {id: 'p2'}];
  rememberImportTarget('lib-a', 'image', {projectId: 'p1', folderId: 'image-folder'}, storage);
  rememberImportTarget('lib-a', 'video', {projectId: 'p2', folderId: 'video-folder', mode: 'move', requestId: 'do-not-store'}, storage);
  assert.deepEqual(readImportTarget('lib-a', 'image', projects, storage), {projectId: 'p1', folderId: 'image-folder'});
  assert.deepEqual(readImportTarget('lib-a', 'video', projects, storage), {projectId: 'p2', folderId: 'video-folder'});
  assert.equal(readImportTarget('lib-b', 'video', projects, storage), null);
  assert.equal(readImportTarget('lib-a', 'sfx', projects, storage), null);
  assert.ok([...storage.values.values()].every(value => !value.includes('move') && !value.includes('requestId')));
  assert.equal(readImportTarget('lib-a', 'video', [{id: 'p1'}], storage), null, '删除或归档项目不能继续成为默认目标');
});
test('可选缓存缺失、损坏或不可写不阻断导入，也不接受路径作为目标编号', () => {
  const storage = memory();
  rememberImportTarget('', 'video', {projectId: 'p', folderId: 'root'}, storage); assert.equal(storage.values.size, 0);
  rememberImportTarget('lib', 'video', {projectId: 'p', folderId: '../elsewhere'}, storage); assert.equal(storage.values.size, 0);
  const broken = {getItem() {throw Error('blocked');}, setItem() {throw Error('blocked');}};
  assert.equal(readImportTarget('lib', 'video', [], broken), null);
  assert.doesNotThrow(() => rememberImportTarget('lib', 'video', {projectId: 'p', folderId: 'root'}, broken));
  const corrupt = {getItem: () => '{', setItem() {}};
  assert.equal(readImportTarget('lib', 'video', [{id: 'p'}], corrupt), null);
});
test('待确认是根目录视图，新建分类在根目录创建而不是虚拟路径', () => {
  assert.equal(classificationParent('\u0000pending'), '');
  assert.equal(classificationParent(''), '');
  assert.equal(classificationParent('环境/风声'), '环境/风声');
});
