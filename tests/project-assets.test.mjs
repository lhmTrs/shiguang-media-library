import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { creativeFixture, addLook, addImage } from './helpers/creative-fixture.mjs';
import { canonical, digest } from '../server/project-assets/model.mjs';
import { ProjectAssets } from '../server/project-assets/store.mjs';

test('人物长文本、项目隔离、归档名称和编辑冲突', async () => {
 const f = await creativeFixture(); try {
  let a = await f.store.create({ project_id: f.a.id, name: '角色甲', kind: 'character' });
  a.base_info = '姓名与职业\n'.repeat(3000); a.performance_info = '克制，不改写原文'; a = await f.store.save(a.id, a, 1);
  assert.equal(f.store.get(a.id).base_info, a.base_info); assert.equal(f.store.list({ project_id: f.b.id }).total, 0);
  await assert.rejects(f.store.create({ project_id: f.a.id, name: ' 角色甲 ', kind: 'character' }), /同名/);
  await f.store.create({ project_id: f.b.id, name: '角色甲', kind: 'character' });
  await assert.rejects(f.store.save(a.id, a, 1), e => e.status === 409);
  f.store.archive(a.id, true, a.revision); assert.equal(f.store.list({ project_id: f.a.id }).total, 0);
  const replacement=await f.store.create({project_id:f.a.id,name:'角色甲',kind:'character'}); assert.equal(replacement.archived_at,0); assert.notEqual(replacement.id,a.id);
  const archived=f.store.get(a.id); assert.throws(()=>f.store.archive(a.id,false,archived.revision),/名称已存在/);
  assert.throws(() => f.projects.remove(f.a.id), /创作资产/);
 } finally { await f.close(); }
});
test('两级默认、职责、图片排序、跨人物归属和失效修复', async () => {
 const f = await creativeFixture(); try {
  let a = await f.store.create({ project_id: f.a.id, name: '角色', kind: 'character' }); const l = addLook(a), image = addImage(a, f.media); addImage(a, f.media);
  a = await f.store.save(a.id, a, a.revision); assert.equal(a.looks[0].default_image_id, image.id); assert.equal((await f.store.health(a.id)).images[0].state, 'available');
  const bad = structuredClone(a); bad.images[0].look_id = randomUUID(); await assert.rejects(f.store.save(a.id, bad, a.revision), /造型/);
  const removed = structuredClone(a); removed.images[0].archived_at = Date.now(); await assert.rejects(f.store.save(a.id, removed, a.revision), /默认代表图/);
  a.images.reverse(); a.images[0].crop = { x: 20, y: 30, zoom: 2 }; a = await f.store.save(a.id, a, a.revision); assert.equal(a.images[0].crop.zoom, 2);
  await fs.writeFile(f.image, 'replacement'); assert.equal((await f.store.health(a.id)).images[0].state, 'changed');
  a.images[0].accept_current = true; a = await f.store.save(a.id, a, a.revision); const states = (await f.store.health(a.id)).images; assert.equal(states[0].state, 'available'); assert.equal(states[1].state, 'changed');
  await fs.unlink(f.image); assert.equal((await f.store.health(a.id)).images[0].state, 'missing'); assert.equal(f.store.get(a.id).looks[0].id, l.id);
 } finally { await f.close(); }
});
test('公共人物和跨项目复制：新编号、文件复用、来源、幂等与来源过期', async () => {
 const f = await creativeFixture(); try {
  const publicId = f.store.scopes().items.find(p => p.project_kind === 'public').id;
  let original = await f.store.create({ project_id: publicId, name: '公共角色', kind: 'character' }); addLook(original); addImage(original, f.media); original = await f.store.save(original.id, original, original.revision);
  assert.equal(f.projects.list().length, 2); assert.throws(() => f.projects.remove(publicId), /公共项目/);
  const p = f.store.copyPreview(original.id, f.a.id), input = { project_id: f.a.id, name: '新角色', source_revision: p.source_revision, request_id: p.request_id };
  const copied = f.store.copy(original.id, input); assert.notEqual(copied.id, original.id); assert.notEqual(copied.looks[0].id, original.looks[0].id); assert.notEqual(copied.images[0].id, original.images[0].id); assert.equal(copied.images[0].media_asset_id, f.media); assert.equal(copied.source.asset_id, original.id); assert.equal(copied.default_look_id, copied.looks[0].id); assert.equal(copied.looks[0].default_image_id, copied.images[0].id);
  assert.equal(f.store.copy(original.id, input).id, copied.id); assert.equal(f.store.copyStatus(input.request_id).completed, true);
  original.name = '公共新名称'; await f.store.save(original.id, original, original.revision); assert.equal(f.store.get(copied.id).name, '新角色');
  assert.throws(() => f.store.copy(original.id, { ...input, request_id: randomUUID(), name: '过期副本' }), /已经更新/);
 } finally { await f.close(); }
});
test('场景道具共用绑定、版本历史与事务失败完整回滚', async () => {
 const f = await creativeFixture(); try {
  for (const kind of ['scene', 'prop']) { let a = await f.store.create({ project_id: f.a.id, name: '同名', kind }); addImage(a, f.media); a.details = { description: '资料', material: '木质' }; a = await f.store.save(a.id, a, a.revision); assert.equal(a.default_image_id, a.images[0].id); assert.equal(f.store.versions(a.id).length, 2); assert.equal(f.store.version(a.id, 1).images.length, 0); }
  let a = await f.store.create({ project_id: f.a.id, name: '事务角色', kind: 'character' }); const before = f.store.backup().checksum; addLook(a);
  f.db.exec("CREATE TRIGGER reject_version BEFORE INSERT ON creative_asset_versions BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END");
  await assert.rejects(f.store.save(a.id, a, a.revision), /synthetic rollback/); assert.equal(f.store.backup().checksum, before);
 } finally { await f.close(); }
});
test('内部备份恢复保留ID、默认关系、来源和时间；冲突不覆盖', async () => {
 const f = await creativeFixture(), g = await creativeFixture(); try {
  let a = await f.store.create({ project_id: f.a.id, name: '备份角色', kind: 'character' }); addLook(a); addImage(a, f.media); a = await f.store.save(a.id, a, a.revision);
  // A restore target starts with no ordinary projects, while retaining its empty system public project.
  g.db.prepare('DELETE FROM media_projects WHERE project_kind=?').run('normal');
  const backup = f.store.backup(); await g.store.restore(backup); assert.equal(canonical(g.store.snapshot()), canonical(f.store.snapshot())); assert.equal(g.store.get(a.id).images[0].id, a.images[0].id);
  const edited = g.store.get(a.id); edited.name = '本地编辑'; await g.store.save(a.id, edited, edited.revision); await assert.rejects(g.store.restore(backup), e => e.status === 409);
 } finally { await f.close(); await g.close(); }
});
test('跨资产子项篡改、父级改变和非法默认引用不留下部分写入', async () => {
 const f = await creativeFixture(); try {
  let a = await f.store.create({ project_id: f.a.id, name: '甲', kind: 'character' }), b = await f.store.create({ project_id: f.b.id, name: '乙', kind: 'character' });
  addLook(a); addImage(a, f.media); a = await f.store.save(a.id, a, 1); addLook(b); b = await f.store.save(b.id, b, 1);
  const original = f.store.backup().checksum, forged = structuredClone(a); forged.looks.push({ ...b.looks[0] });
  await assert.rejects(f.store.save(a.id, forged, a.revision), e => e.status === 409); assert.equal(f.store.backup().checksum, original);
  await assert.rejects(f.store.save(a.id, { ...a, project_id: f.b.id }, a.revision), /所属项目/);
  await assert.rejects(f.store.save(a.id, { ...a, default_look_id: b.looks[0].id }, a.revision), /默认造型/);
  const omitted = structuredClone(a); omitted.images = []; omitted.looks[0].default_image_id = null; await assert.rejects(f.store.save(a.id, omitted, a.revision), /归档/);
  assert.equal(f.store.backup().checksum, original);
 } finally { await f.close(); }
});
test('Unicode名称一致性、失效状态区分和恢复默认规则', async () => {
 const f = await creativeFixture(); try {
  await f.store.create({ project_id: f.a.id, kind: 'character', name: 'Élodie' });
  await assert.rejects(f.store.create({ project_id: f.a.id, kind: 'character', name: 'e\u0301lodie' }), /同名/);
  let a = await f.store.create({ project_id: f.a.id, kind: 'character', name: '默认规则' }); addLook(a); addImage(a, f.media); a = await f.store.save(a.id, a, 1);
  f.db.prepare('UPDATE roots SET online=0 WHERE id=?').run(f.root); assert.equal((await f.store.health(a.id)).images[0].state, 'offline');
  f.db.prepare('UPDATE roots SET online=1,retired=1 WHERE id=?').run(f.root); assert.equal((await f.store.health(a.id)).images[0].state, 'retired');
  f.db.prepare('UPDATE roots SET retired=0 WHERE id=?').run(f.root); f.db.prepare('UPDATE assets SET trashed=1 WHERE id=?').run(f.media); assert.equal((await f.store.health(a.id)).images[0].state, 'trashed');
  f.db.prepare('UPDATE assets SET trashed=0 WHERE id=?').run(f.media); a.images[0].archived_at = Date.now(); a.looks[0].default_image_id = null; a = await f.store.save(a.id, a, a.revision); assert.equal(a.looks[0].default_image_id, null);
  a.images[0].archived_at = null; a.looks[0].default_image_id = a.images[0].id; a = await f.store.save(a.id, a, a.revision); assert.equal(a.images[0].id, a.looks[0].default_image_id);
 } finally { await f.close(); }
});
test('篡改备份即使重算摘要也不能写入悬空关系或伪造schema', async () => {
 const f = await creativeFixture(); try {
  let a = await f.store.create({ project_id: f.a.id, kind: 'character', name: '备份验证' }); addLook(a); addImage(a, f.media); await f.store.save(a.id, a, 1);
  const checksum = f.store.backup().checksum;
  for (const change of [b => { b.tables.creative_image_bindings[0].look_id = randomUUID(); }, b => { b.tables.creative_asset_versions[0].asset_id = randomUUID(); }, b => { b.tables.creative_schema[0].version = 99; }, b => { b.tables.creative_assets[0].project_id = randomUUID(); }]) {
    const b = f.store.backup(); change(b); b.checksum = digest({ tables: b.tables, projects: b.projects }); await assert.rejects(f.store.restore(b)); assert.equal(f.store.backup().checksum, checksum);
  }
 } finally { await f.close(); }
});
test('schema不完整明确停止；重复初始化不新增公共项目', async () => {
 const f = await creativeFixture(); try {
  const publicIds = f.store.scopes().items.filter(p => p.project_kind === 'public').map(p => p.id); f.store.init(); assert.deepEqual(f.store.scopes().items.filter(p => p.project_kind === 'public').map(p => p.id), publicIds);
  f.db.exec('ALTER TABLE creative_looks DROP COLUMN source_json'); assert.throws(() => new ProjectAssets(f.lib).init(), /升级未完成/);
 } finally { await f.close(); }
});
