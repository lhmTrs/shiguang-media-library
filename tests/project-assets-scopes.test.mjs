import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { DEFAULT_DIMENSIONS } from '../server/project-attributes/model.mjs';
import { canonical, digest } from '../server/project-assets/model.mjs';
import { ScopedProjectAssets } from '../server/project-assets/scoped.mjs';
import { addImage, addLook, creativeFixture } from './helpers/creative-fixture.mjs';

const missing = { status: 404, code: 'ASSET_SCOPE_NOT_FOUND' };
const readOnly = { edit_base: false, create_override: false, append: false, promote: false, archive: false };
const manual = value => ({ value, source: 'manual', reason: null, updated_at: 200 });
const pick = result => result.items.map(item => item.asset.id);
const fieldValue = ({ value, source }) => ({ value, source });

async function fixture(t) {
  const f = await creativeFixture();
  t.after(f.close);
  const directory = f.projects.series;
  const series = directory.createSeries({ name: '合成剧', request_id: randomUUID() });
  const season = directory.createSeason(series.id, { label: '测试季', request_id: randomUUID() });
  const otherSeason = directory.createSeason(series.id, { request_id: randomUUID() });
  const episode = (seriesId, seasonId, number) => directory.createEpisode(seriesId, {
    season_id: seasonId, expected_episode_no: number, request_id: randomUUID(),
  }).project;
  const ep = episode(series.id, season.id, 1), peer = episode(series.id, season.id, 2);
  const rootEpisode = episode(series.id, null, 1);
  const other = directory.createSeries({ name: '另一个合成剧', request_id: randomUUID() });
  const otherEpisode = episode(other.id, null, 1);
  const publicId = f.store.scopes().items.find(project => project.project_kind === 'public').id;
  return { ...f, directory, series, season, otherSeason, ep, peer, rootEpisode, other, otherEpisode, publicId, scoped: new ScopedProjectAssets(f.store) };
}

const local = (f, projectId, name, kind = 'character') => f.store.create({ project_id: projectId, kind, name });

function makeShared(f, asset, seriesId = f.series.id) {
  // Seed only the isolated fixture's owner columns. Read tests are independent
  // of how a future scoped create/promotion operation writes these rows.
  f.db.prepare("UPDATE creative_assets SET owner_type='series',owner_id=?,project_id=NULL WHERE id=?").run(seriesId, asset.id);
  return asset;
}

function putOverride(f, type, scopeId, assetId, key, value, revision = 1) {
  const id = digest([type, scopeId, assetId, key]);
  f.db.prepare(`INSERT INTO creative_asset_overrides (id,scope_type,scope_id,asset_id,field_key,value_json,revision,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json,revision=excluded.revision,updated_at=excluded.updated_at`)
    .run(id, type, scopeId, assetId, key, canonical(value), revision, 100, 100 + revision);
  return id;
}

async function sharedCharacter(f) {
  const draft = await local(f, f.a.id, '共享角色');
  const first = addLook(draft, '日常'), second = addLook(draft, '雨天');
  const base = addImage(draft, f.media, first.id), rain = addImage(draft, f.media, second.id);
  const rainOverride = addImage(draft, f.media, second.id);
  rainOverride.crop = { x: 20, y: 60, zoom: 2 };
  const saved = await f.store.save(draft.id, draft, draft.revision);
  makeShared(f, saved);
  return { saved, first, second, base, rain, rainOverride };
}

test('context and scoped reads keep sibling, standalone, other series and public owners isolated', async t => {
  const f = await fixture(t);
  const { scoped, ep, peer, rootEpisode, series, season, other, otherEpisode, publicId } = f;
  const shared = makeShared(f, await local(f, f.a.id, '共享甲'));
  const episodeAsset = await local(f, ep.id, '本集甲');
  const siblingAsset = await local(f, peer.id, '隔壁集甲');
  const standaloneAsset = await local(f, f.a.id, '独立甲');
  const otherShared = makeShared(f, await local(f, f.b.id, '另剧共享'), other.id);
  const publicAsset = await local(f, publicId, '公共角色');

  const context = scoped.assetContext(ep.id);
  assert.deepEqual(context, {
    project: { id: ep.id, name: ep.name }, series: { id: series.id, name: series.name },
    season: { id: season.id, name: '测试季' }, membership_revision: 1, context_token: context.context_token,
  });
  assert.match(context.context_token, /^[a-f0-9]{64}$/);
  assert.equal(scoped.assetContext(rootEpisode.id).season, null);
  const solo = scoped.assetContext(f.a.id);
  assert.deepEqual([solo.series, solo.season, solo.membership_revision], [null, null, 0]);
  assert.equal(scoped.scope('season', f.otherSeason.id).season.name, '第 2 季');

  const episodeList = scoped.list('episode', ep.id);
  assert.deepEqual(episodeList.scope, { type: 'episode', id: ep.id });
  assert.equal(episodeList.context_token, context.context_token);
  assert.equal(episodeList.total, 2);
  assert.deepEqual(new Set(pick(episodeList)), new Set([shared.id, episodeAsset.id]));
  assert.deepEqual(new Set(pick(scoped.list('episode', peer.id))), new Set([shared.id, siblingAsset.id]));
  assert.deepEqual(pick(scoped.list('series', series.id)), [shared.id]);
  assert.deepEqual(pick(scoped.list('season', season.id)), [shared.id]);
  assert.deepEqual(pick(scoped.list('episode', rootEpisode.id)), [shared.id]);
  assert.deepEqual(pick(scoped.list('episode', f.a.id)), [standaloneAsset.id]);
  assert.deepEqual(pick(scoped.list('episode', otherEpisode.id)), [otherShared.id]);
  assert.deepEqual(f.store.list({ project_id: publicId }).items.map(row => row.id), [publicAsset.id]);
  assert.deepEqual(f.store.list({ project_id: ep.id }).items.map(row => row.id), [episodeAsset.id]);

  for (const [type, id, assetId] of [
    ['episode', ep.id, siblingAsset.id], ['episode', ep.id, otherShared.id], ['episode', ep.id, publicAsset.id],
    ['series', series.id, episodeAsset.id], ['season', season.id, episodeAsset.id],
    ['episode', f.a.id, shared.id], ['episode', publicId, publicAsset.id],
    ['episode', randomUUID(), shared.id], ['project', ep.id, episodeAsset.id],
  ]) assert.throws(() => scoped.detail(type, id, assetId), missing);
  assert.throws(() => scoped.assetContext(publicId), missing);
  const localItem = scoped.detail('episode', ep.id, episodeAsset.id);
  assert.deepEqual(localItem.owner, { type: 'project', id: ep.id, name: ep.name });
  assert.deepEqual(localItem.capabilities, readOnly);
  assert.equal(localItem.effective.default_look.parent, null);
  assert.deepEqual(localItem.effective.default_look.source, { type: 'project', id: ep.id, revision: episodeAsset.revision });
  assert.deepEqual(scoped.detail('series', series.id, shared.id).owner, { type: 'series', id: series.id, name: series.name });
});

test('character defaults inherit per field, skip invalid targets, and keep the selected offline cover and crop', async t => {
  const f = await fixture(t);
  const { scoped, db, ep, peer, season, series } = f;
  const { saved, first, second, base, rain, rainOverride } = await sharedCharacter(f);
  putOverride(f, 'season', season.id, saved.id, 'default_look', second.id, 2);
  putOverride(f, 'season', season.id, saved.id, 'default_image:' + second.id, rainOverride.id, 4);
  putOverride(f, 'episode', ep.id, saved.id, 'default_look', first.id, 5);
  putOverride(f, 'episode', ep.id, saved.id, 'default_image:' + second.id, base.id, 6); // wrong look
  db.prepare('UPDATE roots SET online=0 WHERE id=?').run(f.root);

  const seriesItem = scoped.detail('series', series.id, saved.id);
  const seasonItem = scoped.detail('season', season.id, saved.id);
  const detail = scoped.detail('episode', ep.id, saved.id);
  const peerItem = scoped.detail('episode', peer.id, saved.id);
  assert.equal(seriesItem.effective.default_look.value, first.id);
  assert.equal(seriesItem.effective.default_look.parent, null);
  assert.equal(seriesItem.effective.default_images[second.id].value, rain.id);
  assert.deepEqual(seasonItem.effective.default_look.override, { value: second.id, revision: 2 });
  assert.deepEqual(seasonItem.effective.default_look.parent, fieldValue(seriesItem.effective.default_look));
  assert.deepEqual(detail.effective.default_look.override, { value: first.id, revision: 5 });
  assert.deepEqual(detail.effective.default_look.source, { type: 'episode', id: ep.id, revision: 5 });
  assert.deepEqual(detail.effective.default_look.parent, fieldValue(seasonItem.effective.default_look));
  assert.deepEqual(detail.effective.default_images[second.id].source, { type: 'season', id: season.id, revision: 4 });
  assert.deepEqual(detail.effective.default_images[second.id].parent, fieldValue(seasonItem.effective.default_images[second.id]));
  assert.equal(detail.effective.default_images[second.id].override, null);
  assert.equal(detail.effective.cover.id, base.id);
  assert.equal(peerItem.effective.cover.id, rainOverride.id);
  assert.equal(peerItem.effective.cover.health.state, 'offline');
  assert.deepEqual(peerItem.effective.cover.crop, rainOverride.crop);
  assert.equal(peerItem.asset.project_id, null);
  assert.equal(peerItem.asset.default_look_id, first.id);
  assert.equal(peerItem.asset.looks.find(look => look.id === second.id).default_image_id, rain.id);

  const listed = scoped.list('episode', peer.id).items[0];
  const { cover, look_count, ...envelope } = listed;
  assert.deepEqual(envelope, peerItem);
  assert.deepEqual(cover, peerItem.effective.cover);
  assert.equal(look_count, 2);

  db.prepare('UPDATE creative_image_bindings SET archived_at=300 WHERE id=?').run(rainOverride.id);
  assert.equal(scoped.detail('episode', peer.id, saved.id).effective.cover.id, rain.id);
  db.prepare('UPDATE creative_looks SET archived_at=300 WHERE id=?').run(second.id);
  const fallback = scoped.detail('episode', peer.id, saved.id);
  assert.equal(fallback.effective.default_look.value, first.id);
  assert.equal(fallback.effective.default_look.parent.source.type, 'series');
  assert.equal(Object.hasOwn(fallback.effective.default_images, second.id), false);
  assert.equal(fallback.effective.cover.id, base.id);
});

test('scene and prop defaults use the null look key; archived rows stay queryable', async t => {
  const f = await fixture(t);
  const { scoped, series, season, ep } = f;
  for (const kind of ['scene', 'prop']) {
    const draft = await local(f, f.a.id, '共享参考' + kind, kind);
    const first = addImage(draft, f.media), second = addImage(draft, f.media);
    makeShared(f, await f.store.save(draft.id, draft, draft.revision));
    putOverride(f, 'season', season.id, draft.id, 'default_image', second.id);
    const detail = scoped.detail('episode', ep.id, draft.id);
    assert.deepEqual(Object.keys(detail.effective.default_images), ['null']);
    assert.equal(detail.effective.default_images.null.value, second.id);
    assert.equal(detail.effective.default_images.null.parent.value, second.id);
    assert.equal(detail.effective.cover.look_id, null);
    assert.equal(detail.effective.default_look, undefined);
    assert.deepEqual(detail.effective.attribute_scores, {});
    f.db.prepare('DELETE FROM creative_image_bindings WHERE id=?').run(second.id);
    assert.equal(scoped.detail('episode', ep.id, draft.id).effective.cover.id, first.id);

    f.db.prepare('UPDATE creative_assets SET archived_at=300 WHERE id=?').run(draft.id);
    assert.equal(scoped.list('series', series.id, { kind }).total, 0);
    const archived = scoped.list('series', series.id, { kind, archived: 'true' });
    assert.deepEqual(pick(archived), [draft.id]);
    assert.equal(archived.items[0].asset.archived_at, 300);
    assert.equal(scoped.detail('series', series.id, draft.id).asset.id, draft.id);
  }
});

test('scoped search and pagination use legacy literal name and base text matching', async t => {
  const f = await fixture(t);
  const { scoped, series, ep } = f;
  const shared = makeShared(f, await local(f, f.a.id, 'FOO%共享'));
  let episodeAsset = await local(f, ep.id, '本集');
  episodeAsset.base_info = 'foo% in profile';
  episodeAsset = await f.store.save(episodeAsset.id, episodeAsset, episodeAsset.revision);
  await local(f, ep.id, 'FooWithoutPercent');
  await local(f, f.peer.id, 'foo%在其他集');
  f.db.prepare('UPDATE creative_assets SET updated_at=5000 WHERE id=?').run(shared.id);
  const search = { q: 'FOO%', size: '1' };
  const first = scoped.list('episode', ep.id, search), second = scoped.list('episode', ep.id, { ...search, page: '2' });
  assert.deepEqual([first.total, first.page, ...pick(first)], [2, 1, episodeAsset.id]);
  assert.deepEqual([second.total, second.page, ...pick(second)], [2, 2, shared.id]);
  assert.equal(scoped.list('episode', ep.id, { ...search, page: 3 }).total, 2);
  assert.deepEqual(pick(scoped.list('episode', ep.id, { ...search, page: 3 })), []);
  assert.equal(scoped.list('episode', ep.id, { size: '2' }).items.length, 2);
  assert.deepEqual(pick(scoped.list('series', series.id, search)), [shared.id]);
});

test('shared scoring distinguishes absent, explicit unscored and zero; local scores use the episode config', async t => {
  const f = await fixture(t);
  const { scoped, db, ep, season, series } = f;
  const shared = makeShared(f, await local(f, f.a.id, '共享评分角色'));
  const localAsset = await local(f, ep.id, '本集评分角色');
  const [first, second, third] = DEFAULT_DIMENSIONS;
  const defaultConfig = scoped.attributeConfig('series', series.id);
  assert.deepEqual([defaultConfig.revision, defaultConfig.source, defaultConfig.updated_at], [0, 'default', null]);
  assert.deepEqual(defaultConfig.dimensions.map(dim => dim.id), DEFAULT_DIMENSIONS.map(dim => dim.id));
  assert.deepEqual(scoped.attributeScores('series', series.id, shared.id), {
    asset_id: shared.id, series_id: series.id, config_revision: 0, attribute_revision: 0, scores: {},
  });

  const seriesDimensions = [first, second, third].map(dim => ({ ...dim, id: randomUUID() }));
  const [d0, d1, d2] = seriesDimensions.map(dim => dim.id);
  const cfg = { source: 'user', updated_at: 200, dimensions: seriesDimensions };
  db.prepare('INSERT INTO series_attribute_configs (id,revision,data_json,created_at,updated_at) VALUES(?,3,?,100,200)')
    .run(series.id, canonical(cfg));
  const scores = { [d0]: manual(30), [d1]: manual(0) };
  db.prepare('INSERT INTO series_character_attributes (id,series_id,revision,data_json,created_at,updated_at) VALUES(?,?,4,?,100,200)')
    .run(shared.id, series.id, canonical(scores));
  db.prepare('INSERT INTO project_character_attributes (id,project_id,revision,data_json) VALUES(?,?,2,?)')
    .run(localAsset.id, ep.id, canonical({ [first.id]: manual(-8) }));
  const overrideId = putOverride(f, 'episode', ep.id, shared.id, 'attribute_score:' + d0, manual(null), 5);
  putOverride(f, 'season', season.id, shared.id, 'attribute_score:' + d1, manual(90)); // season scores never apply
  const effective = scoped.detail('episode', ep.id, shared.id).effective;
  assert.equal(effective.attribute_config_revision, 3);
  assert.deepEqual(effective.attribute_scores[d0].value, manual(null));
  assert.deepEqual(effective.attribute_scores[d0].source, { type: 'episode', id: ep.id, revision: 5 });
  assert.deepEqual(effective.attribute_scores[d0].override, { value: manual(null), revision: 5 });
  assert.deepEqual(effective.attribute_scores[d0].parent, { value: manual(30), source: { type: 'series', id: series.id, revision: 4 } });
  assert.equal(effective.attribute_scores[d1].value.value, 0);
  assert.equal(effective.attribute_scores[d2].value, null);
  assert.equal(effective.attribute_scores[d2].override, null);
  const seasonScore = scoped.detail('season', season.id, shared.id).effective.attribute_scores[d1];
  assert.equal(seasonScore.value.value, 0);
  assert.equal(seasonScore.source.type, 'series');
  assert.equal(seasonScore.parent, null);
  assert.equal(seasonScore.override, null);

  assert.equal(scoped.attributeConfig('episode', ep.id, shared.id).revision, 3);
  assert.equal(scoped.attributeConfig('episode', ep.id, shared.id).series_id, series.id);
  assert.deepEqual(scoped.attributeConfig('episode', ep.id, localAsset.id), scoped.attributeConfig('episode', ep.id));
  assert.equal(scoped.attributeConfig('episode', ep.id).project_id, ep.id);
  assert.throws(() => scoped.attributeConfig('episode', f.peer.id, localAsset.id), missing);
  assert.deepEqual(scoped.attributeScores('series', series.id, shared.id), {
    asset_id: shared.id, series_id: series.id, config_revision: 3, attribute_revision: 4, scores,
  });
  const localEffective = scoped.detail('episode', ep.id, localAsset.id).effective;
  assert.equal(localEffective.attribute_config_revision, 0);
  assert.equal(localEffective.attribute_scores[first.id].value.value, -8);
  assert.equal(localEffective.attribute_scores[first.id].source.type, 'project');
  assert.equal(localEffective.attribute_scores[first.id].parent, null);
  assert.equal(Object.hasOwn(localEffective.attribute_scores, d0), false);

  db.prepare('DELETE FROM creative_asset_overrides WHERE id=?').run(overrideId);
  const inherited = scoped.detail('episode', ep.id, shared.id).effective.attribute_scores[d0];
  assert.equal(inherited.value.value, 30);
  assert.equal(inherited.override, null);
  assert.equal(inherited.source.type, 'series');
});

test('tokens bind the actual scope and field versions; read helpers work inside caller transactions', async t => {
  const f = await fixture(t);
  const { scoped, db, ep, peer, series, season } = f;
  const { saved, first, second } = await sharedCharacter(f);
  const initial = scoped.detail('episode', ep.id, saved.id);
  const token = initial.effective.default_look.write_token;
  const otherField = initial.effective.default_images[first.id];
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.notEqual(token, otherField.write_token);
  assert.notEqual(token, scoped.detail('episode', peer.id, saved.id).effective.default_look.write_token);
  assert.notEqual(token, new ScopedProjectAssets(f.store).detail('episode', ep.id, saved.id).effective.default_look.write_token);
  assert.throws(() => scoped.assertWriteToken(otherField, token), { status: 409, code: 'ASSET_STALE' });
  assert.throws(() => scoped.assertWriteToken(initial.effective.default_look, 'f'.repeat(64)), { status: 409, code: 'ASSET_STALE' });
  assert.deepEqual(db.transaction(() => {
    const scope = scoped.scope('episode', ep.id);
    assert.deepEqual([scope.series_id, scope.season_id], [series.id, season.id]);
    scoped.assertContextToken(scope, initial.context_token);
    const detail = scoped.detailInTransaction(scope, saved.id);
    scoped.assertWriteToken(detail.effective.default_look, token);
    return detail;
  })(), initial);

  putOverride(f, 'episode', ep.id, saved.id, 'default_look', first.id);
  const beforeParentChange = scoped.detail('episode', ep.id, saved.id);
  putOverride(f, 'season', season.id, saved.id, 'default_look', second.id);
  const afterParentChange = scoped.detail('episode', ep.id, saved.id);
  assert.equal(afterParentChange.effective.default_look.value, beforeParentChange.effective.default_look.value);
  assert.notEqual(afterParentChange.effective.default_look.write_token, beforeParentChange.effective.default_look.write_token);
  assert.equal(afterParentChange.context_token, beforeParentChange.context_token);

  f.directory.move({ request_id: randomUUID(), target: { series_id: series.id, season_id: f.otherSeason.id },
    items: [{ project_id: ep.id, expected_revision: 1, episode_no: 1 }] });
  const moved = scoped.assetContext(ep.id);
  assert.equal(moved.membership_revision, 2);
  assert.equal(moved.season.id, f.otherSeason.id);
  assert.throws(() => scoped.assertContextToken(scoped.scope('episode', ep.id), initial.context_token), {
    status: 409, code: 'ASSET_SCOPE_CHANGED',
  });
  assert.notEqual(scoped.detail('episode', ep.id, saved.id).effective.default_look.write_token, afterParentChange.effective.default_look.write_token);

  scoped.setWriteCapabilities({ edit_base: true, create_override: true });
  assert.deepEqual(scoped.detail('episode', ep.id, saved.id).capabilities, { ...readOnly, create_override: true });
  assert.deepEqual(scoped.detail('season', season.id, saved.id).capabilities, { ...readOnly, create_override: true });
  assert.deepEqual(scoped.detail('series', series.id, saved.id).capabilities, { ...readOnly, edit_base: true });
});
