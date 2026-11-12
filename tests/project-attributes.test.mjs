import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import express from 'express';
import { projectAgentGuide } from '../server/project-agent-guide.mjs';
import { projectAssetRouter } from '../server/project-assets/router.mjs';
import { digest } from '../server/project-assets/model.mjs';
import { mysqlColumnType } from '../server/mysql.mjs';
import { creativeFixture } from './helpers/creative-fixture.mjs';

function addCharacter(fixture, project = fixture.a, name = '测试人物') {
  return fixture.store.create({ project_id: project.id, name, kind: 'character' });
}

function edit(project, configRevision, attributeRevision, dimensionId, value) {
  return { project_id: project.id, expected_config_revision: configRevision, expected_attribute_revision: attributeRevision,
    changes: [{ dimension_id: dimensionId, value }] };
}

function batch(config, scores) {
  return { request_id: randomUUID(), config_revision: config.revision, scores };
}

function cell(asset, dimension, value = 36) {
  return { asset_id: asset.id, dimension_id: dimension.id, value, reason: '剧本中的明确行动' };
}

test('默认六维和固定 ID；配置编辑、档名与排序；旧版本和退役编号被拒绝', async t => {
  const f = await creativeFixture();
  t.after(f.close);
  const attrs = f.store.attributes;
  const start = attrs.getConfig(f.a.id);
  assert.equal(start.revision, 0);
  assert.equal(start.source, 'default');
  assert.equal(start.updated_at, null);
  assert.equal(start.dimensions.length, 6);
  assert.deepEqual(start.dimensions, attrs.getConfig(f.b.id).dimensions);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM project_attribute_configs').get().n, 0);
  const dimensions = start.dimensions.toReversed();
  const tiers = ['极低', '低', '中间', '高', '极高'];
  dimensions[0] = { ...dimensions[0], name: '立场', tier_labels: tiers };
  dimensions[1] = { ...dimensions[1], id: null };
  const saved = attrs.putConfig(f.a.id, { expected_revision: 0, dimensions });
  assert.equal(saved.revision, 1);
  assert.equal(saved.source, 'user');
  assert.equal(saved.dimensions[0].id, dimensions[0].id);
  assert.notEqual(saved.dimensions[1].id, start.dimensions[4].id);
  assert.deepEqual(saved.dimensions[0].tier_labels, tiers);
  assert.throws(() => attrs.putConfig(f.a.id, { expected_revision: 0, dimensions }), { code: 'CONFIG_STALE' });
  assert.throws(() => attrs.putConfig(f.a.id, { expected_revision: 1, dimensions: start.dimensions }), /退役/);
  const retained = saved.dimensions.map(({ tier_labels, ...d }) => d);
  assert.deepEqual(attrs.putConfig(f.a.id, { expected_revision: 1, dimensions: retained }).dimensions[0].tier_labels, tiers);
});

test('人工清空和零分受保护；AI 回执幂等、重复格拒绝、人物修订独立', async t => {
  const f = await creativeFixture();
  t.after(f.close);
  const attrs = f.store.attributes, a = await addCharacter(f), b = await addCharacter(f, f.b);
  const config = attrs.getConfig(f.a.id);
  const [first, second, third] = config.dimensions;
  const changed = attrs.patchScores(a.id, edit(f.a, 0, 0, first.id, null));
  assert.equal(changed.scores[first.id].value, null);
  assert.equal(changed.scores[first.id].source, 'manual');
  assert.throws(() => attrs.patchScores(a.id, edit(f.a, 0, 0, second.id, 0)), { code: 'ATTRIBUTE_STALE' });
  const input = batch(config, [cell(a, first), cell(a, second, 0), cell(a, third, -100), cell(b, second)]);
  const result = attrs.scoreBatch(f.a.id, input);
  assert.equal(result.applied, 2);
  assert.deepEqual(result.skipped.map(item => item.code), ['MANUAL_PRESERVED', 'ASSET_UNAVAILABLE']);
  assert.equal(attrs.getScores(a.id).scores[second.id].value, 0);
  assert.equal(attrs.getScores(a.id).attribute_revision, 2);
  assert.equal(f.store.get(a.id).revision, a.revision);
  assert.throws(() => attrs.scoreBatch(f.a.id, { ...input, scores: [cell(a, first), cell(a, first)] }), /只能提交一次/);
  assert.throws(() => attrs.scoreBatch(f.a.id, { ...input, scores: [cell(a, first)] }), { code: 'REQUEST_CONFLICT' });
  assert.throws(() => attrs.putConfig(f.a.id, { expected_revision: 0, dimensions: config.dimensions }, 'agent'), { code: 'ATTRIBUTES_ALREADY_SCORED' });
  attrs.putConfig(f.a.id, { expected_revision: 0, dimensions: config.dimensions });
  assert.deepEqual(attrs.scoreBatch(f.a.id, input), result);
  assert.throws(() => attrs.scoreBatch(f.a.id, { ...input, request_id: randomUUID() }), { code: 'CONFIG_STALE' });
  assert.throws(() => attrs.compare(f.a.id, `${a.id},${b.id}`), { status: 404 });
  assert.deepEqual(attrs.compare(f.a.id, a.id).items[0].scores, attrs.getScores(a.id).scores);
});

test('删除预览绑定实际评分和归档变化，确认后一起清除当前与归档分数', async t => {
  const f = await creativeFixture();
  t.after(f.close);
  const attrs = f.store.attributes, a = await addCharacter(f), b = await addCharacter(f, f.a, '归档人物');
  const config = attrs.getConfig(f.a.id), [first, second] = config.dimensions;
  attrs.patchScores(a.id, edit(f.a, 0, 0, first.id, null));
  attrs.patchScores(b.id, edit(f.a, 0, 0, first.id, 23));
  const next = { expected_revision: 0, dimensions: config.dimensions.slice(1) };
  const remove = { expected_revision: 0, remove: [first.id] };
  const preview = attrs.removalPreview(f.a.id, remove);
  assert.deepEqual(preview.affected, [{ dimension_id: first.id, name: first.name, scored_assets: 2, archived_scored_assets: 0 }]);
  f.store.archive(b.id, true, b.revision);
  assert.throws(() => attrs.putConfig(f.a.id, { ...next, removal_confirmation: { token: preview.token } }), { code: 'REMOVAL_PREVIEW_STALE' });
  assert.throws(() => attrs.putConfig(f.a.id, next), { code: 'DIMENSION_REMOVAL_CONFIRM' });
  const again = attrs.removalPreview(f.a.id, remove);
  assert.equal(again.affected[0].archived_scored_assets, 1);
  assert.throws(() => attrs.putConfig(f.a.id, { ...next, dimensions: config.dimensions.filter(d => d.id !== second.id),
    removal_confirmation: { token: again.token } }), { code: 'REMOVAL_PREVIEW_STALE' });
  assert.throws(() => attrs.patchScores(b.id, edit(f.a, 0, 1, second.id, 6)), { status: 404 });
  attrs.putConfig(f.a.id, { ...next, removal_confirmation: { token: again.token } });
  for (const id of [a.id, b.id]) {
    assert.deepEqual(attrs.getScores(id).scores, {});
    assert.equal(attrs.getScores(id).attribute_revision, 2);
  }
  assert.throws(() => attrs.compare(f.a.id, b.id), { status: 404 });
});

test('属性备份复原和幂等回执；旧备份保留现有评分；删除空项目清理配置', async t => {
  const f = await creativeFixture(), target = await creativeFixture();
  t.after(f.close);
  t.after(target.close);
  const a = await addCharacter(f), attrs = f.store.attributes;
  const config = attrs.getConfig(f.a.id);
  const legacyBackup = f.store.backup();
  const input = batch(config, [cell(a, config.dimensions[0])]);
  const response = attrs.scoreBatch(f.a.id, input);
  const snapshot = f.store.backup();
  assert.ok(snapshot.project_attributes);
  await f.store.restore(legacyBackup);
  assert.deepEqual(attrs.scoreBatch(f.a.id, input), response);
  target.projects.remove(target.a.id);
  target.projects.remove(target.b.id);
  await target.store.restore(snapshot);
  assert.deepEqual(target.store.attributes.getScores(a.id), attrs.getScores(a.id));
  assert.deepEqual(target.store.attributes.scoreBatch(f.a.id, input), response);
  const invalid = structuredClone(snapshot);
  invalid.project_attributes.project_character_attributes[0].project_id = f.b.id;
  const { tables, projects, project_attributes } = invalid;
  invalid.checksum = digest({ tables, projects, project_attributes });
  await assert.rejects(f.store.restore(invalid), /人物属性备份记录无效/);
  attrs.putConfig(f.b.id, { expected_revision: 0, dimensions: config.dimensions }, 'agent');
  assert.equal(attrs.getConfig(f.b.id).source, 'agent');
  assert.deepEqual(f.projects.remove(f.b.id), { removed: true });
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM project_attribute_configs WHERE id=?').get(f.b.id).n, 0);
});

test('实际项目资产路由响应与分享说明一致，版本 0 的冲突字段可读', async t => {
  const f = await creativeFixture();
  t.after(f.close);
  const app = express();
  app.use('/api/project-assets', projectAssetRouter(f.store, fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next)));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/project-assets`;
  const api = async (path, method = 'GET', body) => {
    const res = await fetch(base + path, { method, ...(body && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: res.status, data: await res.json() };
  };
  const configPath = `/projects/${f.a.id}/attribute-config`;
  const { data: config } = await api(configPath);
  const a = await addCharacter(f), path = `/assets/${a.id}/attributes`;
  const [first] = config.dimensions;
  const request = await api(path, 'PATCH', edit(f.a, 1, 0, first.id, 0));
  assert.equal(request.status, 409);
  assert.equal(request.data.code, 'CONFIG_STALE');
  assert.equal(request.data.current_revision, 0);
  assert.equal(request.data.current.attribute_revision, 0);
  assert.equal((await api(path, 'PATCH', edit(f.a, 0, 0, first.id, 0))).status, 200);
  const preview = await api(configPath + '/removal-preview', 'POST', { expected_revision: 0, remove: [first.id] });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.affected[0].scored_assets, 1);
  assert.equal((await api(configPath, 'PUT', { expected_revision: 0, dimensions: config.dimensions.slice(1),
    removal_confirmation: { token: preview.data.token } })).status, 200);
  const guide = projectAgentGuide({ project: f.a, origin: 'http://127.0.0.1', instanceId: 'test' });
  for (const path of ['/script', '/attribute-config', '/attribute-config/initialize', '/attribute-scores']) {
    assert.ok(guide.includes(`/api/project-assets/projects/${f.a.id}${path}`));
  }
  assert.equal(mysqlColumnType('project_attribute_requests', { name: 'id' }), 'CHAR(64) PRIMARY KEY');
});

test('回执持久化失败时，整批评分原样保留', async t => {
  const f = await creativeFixture();
  t.after(f.close);
  const a = await addCharacter(f), attrs = f.store.attributes, config = attrs.getConfig(f.a.id);
  const input = batch(config, [cell(a, config.dimensions[0])]);
  f.db.exec(`CREATE TRIGGER fail_receipt BEFORE INSERT ON project_attribute_requests
    BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`);
  assert.throws(() => attrs.scoreBatch(f.a.id, input), /synthetic failure/);
  assert.equal(attrs.getScores(a.id).attribute_revision, 0);
  assert.deepEqual(attrs.getScores(a.id).scores, {});
  f.db.exec('DROP TRIGGER fail_receipt');
  assert.equal(attrs.scoreBatch(f.a.id, input).applied, 1);
});
