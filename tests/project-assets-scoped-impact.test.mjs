import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { DEFAULT_DIMENSIONS } from '../server/project-attributes/model.mjs';
import { ScopedAssetImpact } from '../server/project-assets/scoped-impact.mjs';
import { StoryboardDatabase } from '../server/storyboard/database.mjs';
import { emptyShot } from '../server/storyboard/shared/model.mjs';
import { addImage, addLook, creativeFixture } from './helpers/creative-fixture.mjs';
import { syntheticSource } from './helpers/storyboard-fixture.mjs';

async function fixture(t) {
  const f = await creativeFixture();
  t.after(f.close);
  const directory = f.projects.series;
  const series = directory.createSeries({ name: '合成剧', request_id: randomUUID() });
  const season = directory.createSeason(series.id, { label: '合成季', request_id: randomUUID() });
  const episode = (seasonId, number) => directory.createEpisode(series.id, {
    season_id: seasonId, expected_episode_no: number, request_id: randomUUID(),
  }).project;
  const origin = episode(season.id, 1), peer = episode(season.id, 2), root = episode(null, 1);
  const board = new StoryboardDatabase(f.lib, f.store).init();
  let time = Date.now();
  const impact = new ScopedAssetImpact(f.store, { now: () => time });
  const context = (type, id) => ({ context_token: f.store.scoped.scope(type, id).context_token });
  const writes = f.store.scopedWrites;
  const shared = (kind, name) => writes.create('series', series.id, {
    ...context('series', series.id), request_id: randomUUID(), kind, name, on_shared: 'reject',
  }).asset;
  const request = (type, id, preview) => ({ ...context(type, id), request_id: randomUUID(), preview_token: preview.preview_token });
  const local = (name, kind = 'character') => f.store.create({ project_id: origin.id, kind, name });
  const promotion = id => impact.previewPromotion('episode', origin.id, id, context('episode', origin.id));
  const archive = (asset, target, replacement_id) => impact.previewArchive('series', series.id, asset, {
    ...context('series', series.id), target, ...(replacement_id !== undefined && { replacement_id }),
  });
  const override = (type, scopeId, asset, field, value) => {
    const current = f.store.scoped.detail(type, scopeId, asset);
    const effective = field.key === 'default_look'
      ? current.effective.default_look : current.effective.default_images[String(field.look_id ?? null)];
    return writes.setOverride(type, scopeId, asset, {
      ...context(type, scopeId), request_id: randomUUID(), write_token: effective.write_token, field, action: 'set', value,
    });
  };
  return { ...f, directory, series, season, origin, peer, root, board, impact, context, writes, shared, request, local,
    promotion, archive, override, expire: () => { time += 5 * 60 * 1000; } };
}

async function character(f, asset) {
  const first = addLook(asset, '日常'), second = addLook(asset, '节日');
  const image = addImage(asset, f.media, first.id);
  const spare = addImage(asset, f.media, first.id);
  const other = addImage(asset, f.media, second.id);
  const saved = asset.owner_type === 'series'
    ? (await f.writes.save('series', f.series.id, asset.id, {
      ...f.context('series', f.series.id), request_id: randomUUID(), expected_revision: asset.revision, asset,
    })).asset
    : await f.store.save(asset.id, asset, asset.revision);
  return { asset: saved, first, second, image, spare, other };
}

function initialize(f, episode, source = syntheticSource(), expected_revision = null) {
  return f.board.initialize(episode.id, { source, expected_revision, request_id: randomUUID() });
}

test('promotion retains identity, child rows, history and linked shots while migrating manual scores to the source episode', async t => {
  const f = await fixture(t);
  const { asset } = await character(f, await f.local('陈川'));
  const source = initialize(f, f.origin);
  const beforeStory = f.board.head(f.origin.id);
  const beforeLinks = f.db.prepare('SELECT * FROM storyboard_asset_links WHERE document_id=? ORDER BY id').all(beforeStory.id);
  const oldVersion = f.store.version(asset.id, asset.revision);
  const children = table => f.db.prepare('SELECT * FROM ' + table + ' WHERE asset_id=? ORDER BY id').all(asset.id);
  const looks = children('creative_looks'), bindings = children('creative_image_bindings');
  const [zero, unscored] = DEFAULT_DIMENSIONS.map(row => row.id);
  const beforeScores = f.store.attributes.patchScores(asset.id, {
    project_id: f.origin.id, config_token:f.store.attributes.getConfig(f.origin.id).config_token, expected_config_revision: 0, expected_attribute_revision: 0,
    changes: [{ dimension_id: zero, value: 0 }, { dimension_id: unscored, value: null }],
  }).scores;
  const preview = f.promotion(asset.id);
  assert.deepEqual(preview.impact.blockers, []);
  assert.equal(preview.impact.explicit_shots[0].id, source.project.scenes[0].shots[0].id);
  assert.deepEqual(new Set(preview.impact.episodes.map(row => row.id)), new Set([f.origin.id, f.peer.id, f.root.id]));
  assert.deepEqual(preview.impact.seasons.map(row => row.id), [f.season.id]);
  const request = f.request('episode', f.origin.id, preview);
  const beforePromotion = f.store.backup();
  f.db.exec("CREATE TRIGGER fail_promotion_version BEFORE INSERT ON creative_asset_versions BEGIN SELECT RAISE(ABORT, 'synthetic version failure'); END");
  assert.throws(() => f.impact.commitPromotion('episode', f.origin.id, asset.id, request), /synthetic version failure/);
  f.db.exec('DROP TRIGGER fail_promotion_version');
  assert.deepEqual(f.store.backup(), beforePromotion);
  const result = f.impact.commitPromotion('episode', f.origin.id, asset.id, request);
  assert.deepEqual(result.owner, { type: 'series', id: f.series.id, name: f.series.name });
  assert.equal(result.asset.id, asset.id);
  assert.equal(result.asset.project_id, null);
  assert.equal(result.asset.created_at, asset.created_at);
  assert.equal(result.asset.revision, asset.revision + 1);
  assert.deepEqual(children('creative_looks'), looks);
  assert.deepEqual(children('creative_image_bindings'), bindings);
  assert.deepEqual(f.store.version(asset.id, asset.revision), oldVersion);
  const audit = f.store.version(asset.id, result.asset.revision).scope_change;
  assert.deepEqual(audit.source_episode, { id: f.origin.id, name: f.origin.name });
  assert.equal(audit.previous_owner.id, f.origin.id);
  assert.deepEqual(f.board.head(f.origin.id), beforeStory);
  assert.deepEqual(f.db.prepare('SELECT * FROM storyboard_asset_links WHERE document_id=? ORDER BY id').all(beforeStory.id), beforeLinks);
  for (const dimension of [zero, unscored]) {
    const field = result.effective.attribute_scores[dimension];
    assert.deepEqual(field.value, beforeScores[dimension]);
    assert.equal(field.source.type, 'episode');
    assert.equal(f.store.scoped.detail('episode', f.peer.id, asset.id).effective.attribute_scores[dimension].value, null);
  }
  assert.equal(f.db.prepare('SELECT * FROM project_character_attributes WHERE id=?').get(asset.id), undefined);
  assert.deepEqual(f.store.scopedWrites.request(request.request_id), { found: true, result });
  f.expire();
  assert.deepEqual(f.impact.commitPromotion('episode', f.origin.id, asset.id, request), result);
  assert.throws(() => f.impact.commitPromotion('episode', f.origin.id, asset.id, { ...request, preview_token: 'different' }),
    { code: 'REQUEST_ID_CONFLICT' });
  assert.doesNotThrow(() => f.board.validateBackup(f.board.backup()));
});

test('promotion blocks same-kind names, incompatible saved dimensions, and AI provenance without touching either owner', async t => {
  const f = await fixture(t), asset = await f.local(' 陈川 ');
  const duplicate = await f.store.create({ project_id: f.peer.id, kind: 'character', name: '陈川' });
  const [changed, ai, missing] = DEFAULT_DIMENSIONS.map(row => row.id);
  const config = DEFAULT_DIMENSIONS.map((row, i) => i === 0 ? { ...row, criterion: '定义已变化' } : row);
  config.splice(2, 1);
  // Legacy episode dimensions still differ until explicitly aligned.
  f.db.prepare('DELETE FROM series_attribute_alignment WHERE id=?').run(f.series.id);
  f.writes.patchConfig('series', f.series.id, {
    ...f.context('series', f.series.id), request_id: randomUUID(), expected_revision: 0, dimensions: config,
  });
  f.store.attributes.patchScores(asset.id, {
    project_id: f.origin.id, config_token:f.store.attributes.getConfig(f.origin.id).config_token, expected_config_revision: 0, expected_attribute_revision: 0,
    changes: [{ dimension_id: changed, value: 0 }, { dimension_id: missing, value: null }],
  });
  f.store.attributes.scoreBatch(f.origin.id, {
    config_token:f.store.attributes.getConfig(f.origin.id).config_token,
    request_id: randomUUID(), config_revision: 0, scores: [{ asset_id: asset.id, dimension_id: ai, value: 23, reason: '合成原因' }],
  });
  const preview = f.promotion(asset.id);
  assert.deepEqual(preview.impact.blockers[0].conflicts.map(row => row.id), [duplicate.id]);
  assert.equal(preview.impact.blockers[0].asset_id, asset.id);
  assert.throws(() => f.impact.commitPromotion('episode', f.origin.id, asset.id, f.request('episode', f.origin.id, preview)),
    { code: 'ASSET_NAME_CONFLICT' });

  f.store.archive(duplicate.id, true, duplicate.revision);
  const next = f.promotion(asset.id);
  assert.deepEqual(next.impact.blockers[0].dimensions.map(row => [row.dimension_id, row.reason]),
    [[changed, 'DIMENSION_DEFINITION_CHANGED'], [ai, 'AI_SCORE_NOT_SUPPORTED_BY_OVERRIDE'], [missing, 'SERIES_DIMENSION_MISSING']]);
  const before = f.store.backup();
  const request = f.request('episode', f.origin.id, next);
  assert.throws(() => f.impact.commitPromotion('episode', f.origin.id, asset.id, request),
    { code: 'ASSET_PROMOTION_ATTRIBUTES_CONFLICT' });
  assert.deepEqual(f.store.backup(), before);
  assert.deepEqual(f.writes.request(request.request_id), { found: false });
});

test('promotion expires and rechecks sibling membership, name and source scores before mutating', async t => {
  const f = await fixture(t), asset = await f.local('待提升');
  const initial = f.promotion(asset.id);
  f.expire();
  assert.throws(() => f.impact.commitPromotion('episode', f.origin.id, asset.id, f.request('episode', f.origin.id, initial)),
    { code: 'ASSET_IMPACT_CHANGED' });
  const staleAudience = f.promotion(asset.id);
  f.directory.createEpisode(f.series.id, { season_id: f.season.id, expected_episode_no: 3, request_id: randomUUID() });
  assert.throws(() => f.impact.commitPromotion('episode', f.origin.id, asset.id, f.request('episode', f.origin.id, staleAudience)),
    { code: 'ASSET_IMPACT_CHANGED' });
  const staleName = f.promotion(asset.id);
  const duplicate = await f.store.create({ project_id: f.peer.id, kind: 'character', name: asset.name });
  assert.throws(() => f.impact.commitPromotion('episode', f.origin.id, asset.id, f.request('episode', f.origin.id, staleName)),
    { code: 'ASSET_IMPACT_CHANGED' });
  f.store.archive(duplicate.id, true, duplicate.revision);
  const staleScore = f.promotion(asset.id);
  f.store.attributes.patchScores(asset.id, { project_id: f.origin.id, config_token:f.store.attributes.getConfig(f.origin.id).config_token, expected_config_revision: 0, expected_attribute_revision: 0,
    changes: [{ dimension_id: DEFAULT_DIMENSIONS[0].id, value: 0 }] });
  assert.throws(() => f.impact.commitPromotion('episode', f.origin.id, asset.id, f.request('episode', f.origin.id, staleScore)),
    { code: 'ASSET_IMPACT_CHANGED' });
  assert.equal(f.store.head(asset.id).owner_type, 'project');
  assert.equal(f.store.versions(asset.id).length, 1);
});

test('look archive requires a valid replacement, preserves child image rows and invalidates covered defaults atomically', async t => {
  const f = await fixture(t);
  const { asset, first, second, image, spare, other } = await character(f, f.shared('character', '全剧人物'));
  f.override('season', f.season.id, asset.id, { key: 'default_look' }, first.id);
  f.override('episode', f.origin.id, asset.id, { key: 'default_image', look_id: first.id }, spare.id);
  f.override('episode', f.peer.id, asset.id, { key: 'default_look' }, second.id);
  const target = { type: 'look', id: first.id };
  const withoutReplacement = f.archive(asset.id, target);
  assert.deepEqual(withoutReplacement.impact.blockers[0].candidates, [{ id: second.id, name: second.name }]);
  assert.throws(() => f.impact.commitArchive('series', f.series.id, asset.id, f.request('series', f.series.id, withoutReplacement)),
    { status: 422, code: 'ASSET_REPLACEMENT_REQUIRED' });
  assert.throws(() => f.archive(asset.id, target, image.id), { status: 422 });

  const preview = f.archive(asset.id, target, second.id);
  const sourceImpact = preview.impact.episodes.find(row => row.id === f.origin.id);
  assert.deepEqual(sourceImpact.fields.find(row => row.key === 'cover'), { key: 'cover', before: spare.id, after: other.id });
  assert.equal(sourceImpact.fields.find(row => row.key === 'default_image' && row.look_id === first.id).invalidates_override, true);
  const request = f.request('series', f.series.id, preview);
  const before = f.store.backup();
  f.db.exec("CREATE TRIGGER fail_archive_receipt BEFORE INSERT ON creative_asset_scope_requests BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END");
  assert.throws(() => f.impact.commitArchive('series', f.series.id, asset.id, request), /synthetic receipt failure/);
  f.db.exec('DROP TRIGGER fail_archive_receipt');
  assert.deepEqual(f.store.backup(), before);

  const result = f.impact.commitArchive('series', f.series.id, asset.id, request);
  assert.equal(result.asset.revision, asset.revision + 1);
  assert.equal(result.asset.default_look_id, second.id);
  assert.ok(result.asset.looks.find(row => row.id === first.id).archived_at > 0);
  assert.deepEqual(result.asset.images.map(row => [row.id, row.archived_at, row.media_asset_id]),
    asset.images.map(row => [row.id, row.archived_at, row.media_asset_id]));
  assert.deepEqual(f.store.snapshot().creative_asset_overrides.map(row => row.scope_id), [f.peer.id]);
  const audit = f.store.version(asset.id, result.asset.revision).scope_change;
  assert.deepEqual(audit.target, target);
  assert.equal(audit.invalidated_overrides.length, 2);
  assert.deepEqual(f.impact.commitArchive('series', f.series.id, asset.id, request), result);
  assert.doesNotThrow(() => f.store.validateBackup(f.store.backup()));
});

test('binding archive retains media and cascades a season fallback while keeping unaffected episode overrides', async t => {
  const f = await fixture(t), { asset, first, image, spare, other } = await character(f, f.shared('character', '全剧人物'));
  f.override('season', f.season.id, asset.id, { key: 'default_image', look_id: first.id }, image.id);
  f.override('episode', f.peer.id, asset.id, { key: 'default_image', look_id: first.id }, spare.id);
  const target = { type: 'image', id: image.id };
  assert.throws(() => f.archive(asset.id, target, other.id), { status: 422 });
  const preview = f.archive(asset.id, target, spare.id);
  assert.deepEqual(preview.impact.seasons[0].fields.find(row => row.key === 'default_image'),
    { key: 'default_image', look_id: first.id, before: image.id, after: spare.id, invalidates_override: true });
  assert.deepEqual(preview.impact.episodes.find(row => row.id === f.peer.id).fields, []);
  const result = f.impact.commitArchive('series', f.series.id, asset.id, f.request('series', f.series.id, preview));
  assert.equal(result.effective.cover.id, spare.id);
  assert.equal(result.asset.images.find(row => row.id === image.id).media_asset_id, f.media);
  assert.ok(result.asset.images.find(row => row.id === image.id).archived_at > 0);
  assert.equal(f.store.scoped.detail('episode', f.peer.id, asset.id).effective.default_images[first.id].source.type, 'episode');
  assert.equal(f.lib.asset(f.media).trashed, 0);
});

test('archive protects explicit scoped shot references and manifest-only assets without treating sibling bindings to the same media as equal', async t => {
  const f = await fixture(t);
  const { asset, first, image, spare } = await character(f, f.shared('character', '陈川'));
  const manifestOnly = f.shared('character', '不出场人物');
  const source = syntheticSource();
  source.scenes[0].shots.push(emptyShot());
  source.assets.push({ id: 'storyboard_reference', path: 'reference.png', media_type: 'image/png', content_hash: 'a'.repeat(64) });
  const referenced = source.scenes[0].shots[0];
  source.reference_bindings.push({ asset_id: 'storyboard_reference', image_binding_id: image.id, subject_id: 'c1',
    locks: '', ignores: '', shot_ids: [referenced.id] });
  initialize(f, f.peer, source);

  const assetPreview = f.archive(asset.id, { type: 'asset', id: asset.id });
  assert.deepEqual(assetPreview.impact.explicit_shots.map(row => [row.id, row.episode_id, row.number]), [[referenced.id, f.peer.id, '01']]);
  assert.equal(assetPreview.impact.blockers[0].code, 'ASSET_IN_USE');
  const manifest = f.archive(manifestOnly.id, { type: 'asset', id: manifestOnly.id });
  assert.deepEqual(manifest.impact.explicit_shots, []);
  assert.equal(manifest.impact.blockers[0].manifests[0].episode_id, f.peer.id);
  const look = f.archive(asset.id, { type: 'look', id: first.id });
  assert.equal(look.impact.explicit_shots[0].id, referenced.id);
  const binding = f.archive(asset.id, { type: 'image', id: image.id }, spare.id);
  assert.equal(binding.impact.explicit_shots[0].id, referenced.id);
  assert.throws(() => f.impact.commitArchive('series', f.series.id, asset.id, f.request('series', f.series.id, binding)),
    { code: 'ASSET_IN_USE' });
  assert.deepEqual(f.archive(asset.id, { type: 'image', id: spare.id }).impact.blockers, []);
});

test('archive rejects stale explicit references and overrides and reports a generating member', async t => {
  const f = await fixture(t), asset = f.shared('scene', '合成客厅');
  const target = { type: 'asset', id: asset.id };
  const stale = f.archive(asset.id, target);
  initialize(f, f.peer);
  assert.throws(() => f.impact.commitArchive('series', f.series.id, asset.id, f.request('series', f.series.id, stale)),
    { code: 'ASSET_IMPACT_CHANGED' });
  const { asset: person, first } = await character(f, f.shared('character', '未绑定角色'));
  const lookTarget = { type: 'look', id: first.id };
  const prior = f.archive(person.id, lookTarget, person.looks[1].id);
  f.override('season', f.season.id, person.id, { key: 'default_look' }, first.id);
  assert.throws(() => f.impact.commitArchive('series', f.series.id, person.id, f.request('series', f.series.id, prior)),
    { code: 'ASSET_IMPACT_CHANGED' });
  const fresh = f.archive(person.id, lookTarget, person.looks[1].id);
  f.store.generationLocks = { assertWritable(id) {
    if (id === f.peer.id) throw Object.assign(new Error('synthetic generation lock'), { status: 423 });
  } };
  assert.throws(() => f.impact.commitArchive('series', f.series.id, person.id, f.request('series', f.series.id, fresh)), error => {
    assert.equal(error.status, 423);
    assert.deepEqual(error.details.episodes, [{ id: f.peer.id, name: f.peer.name }]);
    return true;
  });
});

test('whole archive removes inherited overrides, leaves historical versions and rejects cross-scope or forged previews', async t => {
  const f = await fixture(t), { asset, first } = await character(f, f.shared('character', '可归档人物'));
  const target = { type: 'asset', id: asset.id };
  assert.throws(() => f.impact.previewArchive('episode', f.peer.id, asset.id,
    { ...f.context('episode', f.peer.id), target }), { status: 403 });
  assert.throws(() => f.impact.previewArchive('episode', f.a.id, asset.id,
    { ...f.context('episode', f.a.id), target }), { status: 404 });
  const standalone = await f.store.create({ project_id: f.a.id, kind: 'prop', name: '独立道具' });
  assert.throws(() => f.impact.previewPromotion('episode', f.a.id, standalone.id, f.context('episode', f.a.id)), { status: 403 });
  f.override('season', f.season.id, asset.id, { key: 'default_look' }, first.id);
  const dimension = DEFAULT_DIMENSIONS[0].id;
  const base = f.writes.patchScores('series', f.series.id, asset.id, {
    config_token:f.store.scoped.attributeConfig('series', f.series.id).config_token,
    ...f.context('series', f.series.id), request_id: randomUUID(), expected_config_revision: 0, expected_attribute_revision: 0,
    changes: [{ dimension_id: dimension, value: 0 }],
  }).scores[dimension];
  const episodeScore = f.store.scoped.detail('episode', f.origin.id, asset.id).effective.attribute_scores[dimension];
  const override = f.writes.setOverride('episode', f.origin.id, asset.id, {
    ...f.context('episode', f.origin.id), request_id: randomUUID(), write_token: episodeScore.write_token,
    field: { key: 'attribute_score', dimension_id: dimension }, action: 'set', value: { value: null },
  }).effective.attribute_scores[dimension].value;
  const preview = f.archive(asset.id, target);
  const scoreImpact = row => row.fields.find(field => field.key === 'attribute_score');
  assert.deepEqual(scoreImpact(preview.impact.seasons[0]),
    { key: 'attribute_score', dimension_id: dimension, before: base, after: null });
  assert.deepEqual(scoreImpact(preview.impact.episodes.find(row => row.id === f.origin.id)),
    { key: 'attribute_score', dimension_id: dimension, before: override, after: null, invalidates_override: true });
  const request = f.request('series', f.series.id, preview);
  assert.throws(() => f.impact.commitArchive('series', f.series.id, asset.id,
    { ...request, preview_token: request.preview_token + 'a' }), { code: 'ASSET_IMPACT_CHANGED' });
  assert.throws(() => f.impact.commitPromotion('series', f.series.id, asset.id, request), { code: 'ASSET_IMPACT_CHANGED' });
  const result = f.impact.commitArchive('series', f.series.id, asset.id, request);
  assert.ok(result.asset.archived_at > 0);
  assert.equal(f.store.scoped.list('episode', f.origin.id).items.length, 0);
  assert.equal(f.store.scoped.list('episode', f.origin.id, { archived: true }).items[0].asset.id, asset.id);
  assert.equal(f.store.snapshot().creative_asset_overrides.length, 0);
  assert.equal(f.store.version(asset.id, asset.revision).archived_at, 0);
  assert.equal(f.store.version(asset.id, result.asset.revision).scope_change.invalidated_overrides.length, 2);
  assert.deepEqual(f.writes.seriesScores(f.series.id, asset.id).scores[dimension], base);
});

test('the last episode-owned scene image can be archived without choosing a replacement', async t => {
  const f = await fixture(t);
  const draft = await f.local('独立场景', 'scene');
  const image = addImage(draft, f.media);
  const asset = await f.store.save(draft.id, draft, draft.revision);
  const target = { type: 'image', id: image.id };
  const preview = f.impact.previewArchive('episode', f.origin.id, asset.id, { ...f.context('episode', f.origin.id), target });
  assert.deepEqual(preview.impact.blockers, []);
  assert.deepEqual(preview.impact.episodes[0].fields[0],
    { key: 'default_image', look_id: null, before: image.id, after: null });
  const result = f.impact.commitArchive('episode', f.origin.id, asset.id, f.request('episode', f.origin.id, preview));
  assert.equal(result.asset.default_image_id, null);
  assert.equal(result.effective.cover, null);
  assert.equal(f.store.scoped.detail('episode', f.origin.id, asset.id).asset.owner_id, f.origin.id);
  assert.equal(f.lib.asset(f.media).trashed, 0);
});
