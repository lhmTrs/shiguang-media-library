import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { ScopedAssetAppend } from '../server/project-assets/scoped-append.mjs';
import { projectAssetRouter } from '../server/project-assets/router.mjs';
import { addImage, addLook, creativeFixture } from './helpers/creative-fixture.mjs';

const impactChanged = { status: 409, code: 'ASSET_IMPACT_CHANGED' };
const scopeChanged = { status: 409, code: 'ASSET_SCOPE_CHANGED' };
const noDefaultConsent = { status: 422, code: 'ASSET_DEFAULT_CONFIRMATION_REQUIRED' };
const readOnly = { status: 403, code: 'ASSET_SCOPE_READ_ONLY' };

async function fixture(t) {
  const f = await creativeFixture();
  t.after(f.close);
  let time = Date.now();
  const service = new ScopedAssetAppend(f.store, { now: () => time });
  const directory = f.projects.series;
  const series = directory.createSeries({ name: '合成全剧', request_id: randomUUID() });
  const season = directory.createSeason(series.id, { label: '合成季', request_id: randomUUID() });
  const episode = seasonId => directory.createEpisode(series.id, {
    season_id: seasonId, expected_episode_no: 1, request_id: randomUUID(),
  }).project;
  const ep = episode(season.id), peer = episode(null);
  const context = (project = ep) => f.store.scoped.assetContext(project.id).context_token;
  async function makeAsset(kind = 'character', { look = false, image = false } = {}) {
    let asset = await f.store.create({ project_id: f.a.id, kind, name: randomUUID() });
    if (look) addLook(asset, '已有造型');
    if (image) addImage(asset, f.media);
    if (look || image) asset = await f.store.save(asset.id, asset, asset.revision);
    f.db.prepare("UPDATE creative_assets SET owner_type='series',owner_id=?,project_id=NULL WHERE id=?").run(series.id, asset.id);
    return f.store.get(asset.id);
  }
  const receipt = (asset, lookId = null, project = ep) => service.mediaReceipt('episode', project.id, asset.id, {
    context_token: context(project), look_id: lookId, media_asset_id: f.media,
  });
  const preview = (asset, item, project = ep) => service.preview('episode', project.id, asset.id, {
    context_token: context(project), item,
  });
  const imagePreview = async (asset, lookId = null) => {
    const media = await receipt(asset, lookId);
    return preview(asset, { type: 'image', look_id: lookId, media_receipt_id: media.media_receipt_id });
  };
  const confirm = (preview_token, extra = {}) => ({
    request_id: randomUUID(), context_token: context(), preview_token, ...extra,
  });
  const commit = (asset, input) => service.commit('episode', ep.id, asset.id, input);
  return { ...f, directory, series, season, ep, peer, context, service, makeAsset, receipt, preview, imagePreview, confirm, commit,
    advance: ms => { time += ms; } };
}

test('the first look requires consent and records the source episode; further appends preserve the old rows', async t => {
  const f = await fixture(t);
  const asset = await f.makeAsset();
  const first = await f.preview(asset, { type: 'look', name: ' 日常 ', description: '首套造型' });
  assert.equal(first.sets_series_default, true);
  assert.deepEqual(first.impact.seasons.map(row => [row.id, row.name]), [[f.season.id, '合成季']]);
  assert.deepEqual(new Set(first.impact.episodes.map(row => row.id)), new Set([f.ep.id, f.peer.id]));
  assert.deepEqual(first.impact.explicit_shots, []);
  assert.deepEqual(first.impact.blockers, []);
  assert.deepEqual(f.store.get(asset.id), asset);
  const noConsent = f.confirm(first.preview_token);
  await assert.rejects(f.commit(asset, noConsent), noDefaultConsent);
  assert.equal(f.store.scopedWrites.request(noConsent.request_id).found, false);
  await assert.rejects(f.commit(asset, { ...noConsent, allow_series_default: 'true' }), { status: 422 });
  const result = await f.commit(asset, { ...noConsent, allow_series_default: true });
  const added = result.asset.looks[0];
  assert.equal(added.name, '日常');
  assert.equal(added.description, '首套造型');
  assert.equal(result.asset.default_look_id, added.id);
  assert.equal(result.effective.default_look.value, added.id);
  assert.deepEqual(first.impact.episodes[0].fields, [{ key: 'default_look', before: null, after: added.id }]);
  assert.deepEqual(added.source, { type: 'episode_append', episode_id: f.ep.id, episode_name: f.ep.name, appended_at: added.created_at });
  assert.deepEqual(f.store.version(asset.id, result.asset.revision).looks[0].source, added.source);

  const beforeRow = f.db.prepare('SELECT * FROM creative_looks WHERE id=?').get(added.id);
  const second = await f.preview(asset, { type: 'look', name: '雨天' });
  assert.equal(second.sets_series_default, false);
  assert.ok(second.impact.episodes.every(row => row.fields.length === 0));
  const secondResult = await f.commit(asset, f.confirm(second.preview_token));
  assert.equal(secondResult.asset.looks.length, 2);
  assert.equal(secondResult.asset.default_look_id, added.id);
  assert.deepEqual(f.db.prepare('SELECT * FROM creative_looks WHERE id=?').get(added.id), beforeRow);
});

test('media receipt is bound to episode, shared asset, look, and bytes; first image sets only the approved default', async t => {
  const f = await fixture(t);
  const asset = await f.makeAsset('character', { look: true });
  const other = await f.makeAsset('character', { look: true });
  const look = asset.looks[0];
  assert.equal(f.service.uploadTarget('episode', f.ep.id, asset.id, {
    context_token: f.context(), look_id: look.id,
  }).scope.series_id, f.series.id);
  await assert.rejects(f.receipt(asset, other.looks[0].id), { status: 422 });
  const media = await f.receipt(asset, look.id);
  assert.equal(media.media_asset_id, f.media);
  assert.equal(media.file_name, '合成图片');
  assert.equal(media.preview_url, '/api/project-assets/media/' + f.media + '/preview');
  assert.ok(media.expires_at > Date.now());
  const item = { type: 'image', look_id: look.id, media_receipt_id: media.media_receipt_id };
  await assert.rejects(f.preview(asset, item, f.peer), impactChanged);
  await assert.rejects(f.preview(other, { ...item, look_id: other.looks[0].id }), impactChanged);
  assert.equal(f.store.get(asset.id).images.length, 0);

  const planned = await f.preview(asset, item);
  assert.equal(planned.sets_series_default, true);
  await assert.rejects(f.commit(asset, f.confirm(planned.preview_token)), noDefaultConsent);
  const result = await f.commit(asset, f.confirm(planned.preview_token, { allow_series_default: true }));
  const [binding] = result.asset.images;
  assert.deepEqual([binding.look_id, binding.media_asset_id, binding.expected_sha256], [
    look.id, f.media, createHash('sha256').update(await fs.readFile(f.image)).digest('hex'),
  ]);
  assert.equal(result.effective.cover.id, binding.id);
  assert.equal(result.asset.default_look_id, look.id);
  assert.equal(result.asset.looks[0].default_image_id, binding.id);
  assert.equal(binding.source.episode_id, f.ep.id);
  assert.deepEqual(planned.impact.episodes[0].fields, [{ key: 'default_image', look_id: look.id, before: null, after: binding.id }]);
  const oldBinding = f.db.prepare('SELECT * FROM creative_image_bindings WHERE id=?').get(binding.id);
  const second = await f.preview(asset, item);
  assert.equal(second.sets_series_default, false);
  const secondResult = await f.commit(asset, f.confirm(second.preview_token));
  assert.equal(secondResult.effective.cover.id, binding.id);
  assert.deepEqual(f.db.prepare('SELECT * FROM creative_image_bindings WHERE id=?').get(binding.id), oldBinding);
});

test('a changed file or expired token requires new validation, while a committed receipt survives both', async t => {
  const f = await fixture(t);
  const asset = await f.makeAsset('scene');
  const original = await fs.readFile(f.image);
  const media = await f.receipt(asset);
  const item = { type: 'image', look_id: null, media_receipt_id: media.media_receipt_id };
  const plan = await f.preview(asset, item);
  const input = f.confirm(plan.preview_token, { allow_series_default: true });
  const [payload, signature] = plan.preview_token.split('.');
  const forged = payload + '.' + (signature[0] === 'a' ? 'b' : 'a') + signature.slice(1);
  await assert.rejects(f.commit(asset, { ...input, preview_token: forged }), impactChanged);
  await fs.writeFile(f.image, Buffer.alloc(original.length, 12));
  await assert.rejects(f.preview(asset, item), impactChanged);
  await assert.rejects(f.commit(asset, input), impactChanged);
  assert.deepEqual(f.store.get(asset.id), asset);
  await fs.writeFile(f.image, original);

  f.advance(5 * 60 * 1000 + 1);
  await assert.rejects(f.commit(asset, input), impactChanged);
  const refreshed = await f.preview(asset, item);
  const confirmed = f.confirm(refreshed.preview_token, { allow_series_default: true });
  const saved = await f.commit(asset, confirmed);
  assert.equal(saved.asset.default_image_id, saved.appended.id);
  assert.equal(saved.effective.default_images.null.value, saved.appended.id);
  assert.equal(saved.asset.images[0].look_id, null);
  f.advance(15 * 60 * 1000);
  await fs.unlink(f.image);
  await assert.rejects(f.preview(asset, item), impactChanged);
  assert.deepEqual(await f.commit(asset, confirmed), saved);
  assert.deepEqual(f.store.scopedWrites.request(confirmed.request_id), { found: true, result: saved });
  await assert.rejects(f.commit(asset, { ...confirmed, allow_series_default: false }), { status: 409, code: 'REQUEST_ID_CONFLICT' });
});

test('in-place mutation immediately before writes or during readback rolls back child, version and request receipt', async t => {
  const f = await fixture(t);
  const asset = await f.makeAsset('prop');
  const original = await fs.readFile(f.image);
  const plan = await f.imagePreview(asset);
  const input = f.confirm(plan.preview_token, { allow_series_default: true });
  const changed = Buffer.alloc(original.length, 3);
  const lockProjects = f.store.scopedWrites.lockProjects;
  f.store.scopedWrites.lockProjects = function (scope) {
    lockProjects.call(this, scope);
    assert.equal(f.db.inTransaction, true);
    writeFileSync(f.image, changed);
  };
  await assert.rejects(f.commit(asset, input), impactChanged);
  f.store.scopedWrites.lockProjects = lockProjects;
  assert.deepEqual(f.store.get(asset.id), asset);
  assert.equal(f.store.scopedWrites.request(input.request_id).found, false);

  await fs.writeFile(f.image, original);
  f.db.function('change_fixture_image', () => { writeFileSync(f.image, changed); });
  f.db.exec('CREATE TRIGGER change_append_source AFTER INSERT ON creative_asset_versions BEGIN SELECT change_fixture_image(); END');
  await assert.rejects(f.commit(asset, input), impactChanged);
  assert.deepEqual(f.store.get(asset.id), asset);
  assert.equal(f.store.versions(asset.id).length, 1);
  assert.equal(f.store.scopedWrites.request(input.request_id).found, false);
});

test('commit rechecks the current audience, source episode, asset version and other episodes’ generation locks', async t => {
  const f = await fixture(t);
  const asset = await f.makeAsset();
  const item = { type: 'look', name: '合成造型' };
  const plan = await f.preview(asset, item);
  const input = f.confirm(plan.preview_token, { allow_series_default: true });
  f.store.generationLocks = { assertWritable(id) {
    if (id === f.peer.id) throw Object.assign(Error('fixture generation lock'), { status: 423 });
  } };
  await assert.rejects(f.commit(asset, input), error => error.status === 423 && error.details.episodes[0].id === f.peer.id);
  f.store.generationLocks = null;

  f.directory.createEpisode(f.series.id, { season_id: null, expected_episode_no: 2, request_id: randomUUID() });
  await assert.rejects(f.commit(asset, input), impactChanged);
  const updated = await f.preview(asset, item);
  f.db.prepare('UPDATE creative_assets SET revision=revision+1 WHERE id=?').run(asset.id);
  await assert.rejects(f.commit(asset, f.confirm(updated.preview_token, { allow_series_default: true })), impactChanged);
  const next = await f.preview(asset, item);
  const nextInput = f.confirm(next.preview_token, { allow_series_default: true });
  f.directory.move({ request_id: randomUUID(), target: { series_id: f.series.id, season_id: null },
    items: [{ project_id: f.ep.id, expected_revision: 1, episode_no: 3 }] });
  await assert.rejects(f.commit(asset, nextInput), scopeChanged);
  assert.equal(f.store.get(asset.id).looks.length, 0);
});

test('the project-assets router serves scoped media receipt, preview, commit and receipt lookup on a synthetic library', async t => {
  const f = await fixture(t);
  const asset = await f.makeAsset('prop');
  const app = express();
  const asyncRoute = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res, next)).catch(next);
  app.use('/api/project-assets', projectAssetRouter(f.store, asyncRoute));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const base = '/api/project-assets/scopes/episode/' + f.ep.id + '/assets/' + asset.id + '/append';
  const post = (path, body) => fetch(origin + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const context_token = f.context();
  const request = { context_token, look_id: null, media_asset_id: f.media };
  const denied = await post(base.replace('/episode/' + f.ep.id, '/series/' + f.series.id) + '/media-receipt', request);
  assert.equal(denied.status, readOnly.status);
  assert.equal((await denied.json()).code, readOnly.code);
  const issued = await post(base + '/media-receipt', request);
  assert.equal(issued.status, 200);
  const media = await issued.json();
  const image = await fetch(origin + media.preview_url);
  assert.equal(image.status, 200);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), await fs.readFile(f.image));
  const preview = await post(base + '/preview', { context_token, item: {
    type: 'image', look_id: null, media_receipt_id: media.media_receipt_id,
  } });
  assert.equal(preview.status, 200);
  const { preview_token } = await preview.json();
  const request_id = randomUUID();
  const committed = await post(base, { request_id, context_token, preview_token, allow_series_default: true });
  assert.equal(committed.status, 200);
  const result = await committed.json();
  assert.equal(result.asset.default_image_id, result.appended.id);
  assert.equal(result.capabilities.append, true);
  const lookup = await fetch(origin + '/api/project-assets/scoped-requests/' + request_id);
  assert.deepEqual(await lookup.json(), { found: true, result });
});
