import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { StoryboardDatabase } from '../server/storyboard/database.mjs';
import { addLook, creativeFixture } from './helpers/creative-fixture.mjs';
import { syntheticSource } from './helpers/storyboard-fixture.mjs';

async function fixture(t) {
  const f = await creativeFixture();
  t.after(f.close);
  const directory = f.projects.series;
  const series = directory.createSeries({ request_id: randomUUID(), name: '全剧样例' });
  const season = directory.createSeason(series.id, { request_id: randomUUID() });
  const episode = directory.createEpisode(series.id, { request_id: randomUUID(), season_id: season.id, expected_episode_no: 1 }).project;
  const scoped = f.store.scoped, writes = f.store.scopedWrites;
  const create = (kind, name) => writes.create('series', series.id, {
    context_token: scoped.list('series', series.id).context_token, request_id: randomUUID(), kind, name, on_shared: 'reject',
  });
  return { ...f, directory, series, season, episode, scoped, writes, create };
}

test('季设定列表仅列本季直接覆盖，保留实际父值和修订号', async t => {
  const f = await fixture(t), { asset, context_token } = f.create('character', '共享人物');
  const first = addLook(asset, '日常'), second = addLook(asset, '节日');
  await f.writes.save('series', f.series.id, asset.id, {
    request_id: randomUUID(), context_token, expected_revision: asset.revision, asset,
  });
  const current = f.scoped.detail('season', f.season.id, asset.id);
  assert.equal(f.scoped.seasonOverrides('season', f.season.id).total, 0);
  const input = { request_id: randomUUID(), context_token: current.context_token,
    write_token: current.effective.default_look.write_token, field: { key: 'default_look' }, action: 'set', value: second.id };
  const saved = f.writes.setOverride('season', f.season.id, asset.id, input);
  const { total, items } = f.scoped.seasonOverrides('season', f.season.id, { kind: 'character' });
  assert.equal(total, 1);
  assert.deepEqual(items[0], { asset: { id: asset.id, name: asset.name, kind: asset.kind },
    field: { key: 'default_look' }, ...saved.effective.default_look });
  assert.equal(items[0].parent.value, first.id);
  assert.equal(f.scoped.seasonOverrides('season', f.season.id, { kind: 'scene' }).total, 0);
  assert.deepEqual(f.writes.setOverride('season', f.season.id, asset.id, input), saved);
  assert.throws(() => f.writes.setOverride('season', f.season.id, asset.id, {
    ...input, request_id: randomUUID(), value: first.id,
  }), { code: 'ASSET_STALE' });
});

test('评分拒绝共享场景；已移出该剧的集不能再从旧请求取回共享资料', async t => {
  const f = await fixture(t), scene = f.create('scene', '共享场景');
  const dimensions = f.scoped.attributeConfig('series', f.series.id).dimensions;
  assert.throws(() => f.writes.patchScores('series', f.series.id, scene.asset.id, {
    request_id: randomUUID(), context_token: scene.context_token, expected_config_revision: 0,
    expected_attribute_revision: 0, changes: [{ dimension_id: dimensions[0].id, value: 0 }],
  }), { status: 404 });
  assert.equal(f.store.snapshot().series_character_attributes.length, 0);
  const episodeContext = f.scoped.assetContext(f.episode.id);
  const request = { kind: 'scene', name: scene.asset.name, on_shared: 'reuse', request_id: randomUUID(),
    context_token: episodeContext.context_token };
  const reused = f.writes.create('episode', f.episode.id, request);
  assert.equal(reused.asset.id, scene.asset.id);
  assert.equal(f.writes.request(request.request_id).found, true);
  f.directory.move({ request_id: randomUUID(), target: { series_id: null, season_id: null },
    items: [{ project_id: f.episode.id, expected_revision: episodeContext.membership_revision }] });
  assert.deepEqual(f.writes.request(request.request_id), { found: false });
  assert.throws(() => f.writes.create('episode', f.episode.id, request), { status: 404 });
});

test('分镜初始化在同剧复用共享人物 ID，备份保留引用，引用阻止跨剧移动', async t => {
  const f = await fixture(t), target = await creativeFixture();
  t.after(target.close);
  const shared = f.create('character', '陈川');
  const board = new StoryboardDatabase(f.lib, f.store).init();
  const input = { source: syntheticSource(), request_id: randomUUID(), expected_revision: null };
  assert.equal(board.preview(f.episode.id, input).assets.find(row => row.name === '陈川').id, shared.asset.id);
  const { project, revision } = board.initialize(f.episode.id, input);
  assert.equal(project.characters[0].id, shared.asset.id);
  const edited = structuredClone(project);
  edited.scenes[0].shots[0].action = '修改后的合成动作。';
  assert.equal(board.save(f.episode.id, { project: edited, expected_revision: revision }).project.characters[0].id, shared.asset.id);
  const context = f.scoped.assetContext(f.episode.id);
  assert.throws(() => f.directory.move({ request_id: randomUUID(), target: { series_id: null, season_id: null },
    items: [{ project_id: f.episode.id, expected_revision: context.membership_revision }] }), { code: 'ASSET_IN_USE' });
  target.db.prepare("DELETE FROM media_projects WHERE project_kind='normal'").run();
  const restored = new StoryboardDatabase(target.lib, target.store).init();
  await restored.restore(board.backup());
  assert.equal(restored.read(f.episode.id).project.characters[0].id, shared.asset.id);
});
