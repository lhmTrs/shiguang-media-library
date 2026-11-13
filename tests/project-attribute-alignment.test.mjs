import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { creativeFixture, confirmAttributePlan, moveWithAttributePlan } from './helpers/creative-fixture.mjs';
import { digest } from '../server/project-assets/model.mjs';
import { DEFAULT_DIMENSIONS } from '../server/project-attributes/model.mjs';
import { projectAssetRouter } from '../server/project-assets/router.mjs';
import { projectSeriesRouter } from '../server/project-series/router.mjs';
import { StoryboardDatabase } from '../server/storyboard/database.mjs';
import { GenerationStore } from '../server/storyboard-generation/store.mjs';

async function setup(t) {
  const f = await creativeFixture();
  t.after(f.close);
  const series = f.projects.series, attrs = f.store.attributes;
  const makeSeries = (name, {legacy = false} = {}) => {
    const drama = series.createSeries({name, request_id: randomUUID()});
    // Old series have a directory row, without the new alignment marker.
    if (legacy) f.db.prepare('DELETE FROM series_attribute_alignment WHERE id=?').run(drama.id);
    return drama;
  };
  const episode = (drama, number = 1) => series.createEpisode(drama.id, {
    request_id: randomUUID(), season_id: null, expected_episode_no: number,
  }).project;
  const character = (project, name) => f.store.create({project_id: project.id, kind: 'character', name});
  const put = (project, dimensions) => {
    const {revision, config_token} = attrs.getConfig(project.id);
    return attrs.putConfig(project.id, {expected_revision: revision, config_token, dimensions});
  };
  const patch = (asset, dimension_id, value) => {
    const {config_revision, config_token, attribute_revision} = attrs.getScores(asset.id);
    return attrs.patchScores(asset.id, {project_id: asset.project_id, config_token,
      expected_config_revision: config_revision, expected_attribute_revision: attribute_revision,
      changes: [{dimension_id, value}]});
  };
  const preview = (drama, choices) => attrs.alignment.preview(drama.id, {expected_alignment_revision: 0, choices});
  const confirm = (drama, view, request_id = randomUUID()) => attrs.alignment.confirm(drama.id,
    {request_id, preview_token: view.preview_token, choices: view.choices});
  return {...f, series, attrs, makeSeries, episode, character, put, patch, preview, confirm};
}

const fresh = dimension => ({...dimension, id: null});
const emptyTarget = {series_id: null, season_id: null};
const root = drama => ({series_id: drama.id, season_id: null});
const item = (f, project, n) => ({project_id: project.id,
  expected_revision: f.series.membership(project.id).revision, ...(n !== undefined && {episode_no: n})});
const archive = (f, asset) => f.store.archive(asset.id, true, asset.revision);
const withoutToken = ({config_token: _token, ...rest}) => rest;

test('A1/A2: new series is aligned, old identical series needs explicit confirmation and preserves the exact score row', async t => {
  const f = await setup(t);
  const created = f.makeSeries('合成新剧');
  const drama = f.makeSeries('合成旧剧', {legacy: true});
  const ep = f.episode(drama), asset = await f.character(ep, '合成人物');
  const old = f.attrs.getConfig(ep.id), before = f.patch(asset, old.dimensions[0].id, 0);
  assert.equal(f.attrs.alignment.status(created.id).status, 'aligned');
  assert.equal(old.alignment_status, 'pending');
  assert.equal(old.config_editable, true);
  assert.throws(() => f.attrs.putConfig(ep.id, {expected_revision: old.revision, config_token: old.config_token,
    dimensions: old.dimensions}, 'agent'), {code: 'ATTRIBUTE_ALIGNMENT_REQUIRED'});
  const view = f.preview(drama);
  assert.equal(view.episodes[0].comparison, 'identical');
  assert.deepEqual(view.choices, []);
  assert.equal(f.attrs.alignment.history('project', ep.id).items.length, 0);

  const requestId = randomUUID(), result = f.confirm(drama, view, requestId);
  assert.equal(result.scores_remapped, 0);
  assert.equal(result.episodes_updated, 1);
  assert.deepEqual(f.confirm(drama, view, requestId), result);
  assert.deepEqual(f.series.request(requestId), {found: true, result});
  assert.throws(() => f.attrs.alignment.confirm(drama.id, {request_id: requestId, preview_token: 'different', choices: []}), {code: 'REQUEST_ID_CONFLICT'});
  assert.deepEqual(f.attrs.getScores(asset.id).scores, before.scores);
  assert.equal(f.attrs.getScores(asset.id).attribute_revision, before.attribute_revision);
  const config = f.attrs.getConfig(ep.id);
  assert.equal(config.revision, old.revision);
  assert.notEqual(config.config_token, old.config_token);
  assert.equal(config.config_scope, 'series');
  assert.equal(config.config_editable, false);
  assert.deepEqual(f.store.scoped.attributeConfig('episode', ep.id, asset.id), config);
  assert.throws(() => f.attrs.patchScores(asset.id, {project_id: ep.id, config_token: old.config_token,
    expected_config_revision: old.revision, expected_attribute_revision: before.attribute_revision,
    changes: [{dimension_id: old.dimensions[0].id, value: 55}]}), {code: 'ATTRIBUTE_CONTEXT_STALE'});
  assert.throws(() => f.attrs.putConfig(ep.id, {expected_revision: config.revision, config_token: config.config_token,
    dimensions: config.dimensions}), {code: 'SERIES_MANAGED'});
  assert.equal(f.attrs.alignment.history('project', ep.id, {}, result.history_id).before_configs[0].config_owner_id, ep.id);
  assert.equal(f.attrs.alignment.history('series', drama.id, {}, result.history_id).projects[0].project_id, ep.id);
  assert.throws(() => f.attrs.alignment.history('project', f.b.id, {}, result.history_id), {code: 'ATTRIBUTE_HISTORY_NOT_FOUND'});
});

test('A2: an equivalent ID maps automatically, reverse/different axes go to history, AI metadata and archived scores survive', async t => {
  const f = await setup(t), drama = f.makeSeries('旧剧差异', {legacy: true});
  const ep = f.episode(drama), second = f.episode(drama, 2), d = DEFAULT_DIMENSIONS;
  const custom = f.put(ep, [fresh(d[0]), fresh({...d[1], negative_label: d[1].positive_label, positive_label: d[1].negative_label}),
    {...d[2], criterion: '合成新依据'}, d[3], d[4],
    fresh({name: '独立轴', negative_label: '迟疑', neutral_label: '在考虑', positive_label: '果断', criterion: '另一个动作'}), d[5]]);
  const [match, reverse, distinct, , , added] = custom.dimensions;
  const asset = await f.character(ep, '合成归档人物');
  f.patch(asset, match.id, null);
  const scores = [{asset_id: asset.id, dimension_id: reverse.id, value: -40, reason: '逆向原依据'},
    {asset_id: asset.id, dimension_id: added.id, value: 30, reason: '保留原依据'}];
  f.attrs.scoreBatch(ep.id, {request_id: randomUUID(), config_revision: custom.revision, config_token: custom.config_token, scores});
  await archive(f, asset);
  const before = f.attrs.getScores(asset.id).scores;
  const view = f.preview(drama);
  const perEpisode = view.episodes.find(row => row.project_id === ep.id);
  assert.equal(perEpisode.automatic.find(row => row.source_dimension_id === match.id).target_dimension_id, d[0].id);
  assert.equal(perEpisode.decisions.find(row => row.source_dimension_id === reverse.id).reason, 'direction_conflict');
  assert.equal(perEpisode.decisions.find(row => row.source_dimension_id === distinct.id).reason, 'different_meaning');
  const choice = perEpisode.decisions.find(row => row.source_dimension_id === added.id);
  const plan = f.preview(drama, [{item_id: choice.item_id, action: 'add_to_series'}]);
  const newAxis = plan.series_changes.added[0].dimension;
  assert.equal(plan.total_impact.archived_people, 1);
  const result = f.confirm(drama, plan);
  assert.equal(result.scores_remapped, 2);
  assert.equal(result.scores_retained_in_history, 1);
  assert.deepEqual(f.attrs.getScores(asset.id).scores, {[d[0].id]: before[match.id], [newAxis.id]: before[added.id]});
  assert.equal(f.attrs.getConfig(second.id).dimensions.at(-1).id, newAxis.id);
  const history = f.attrs.alignment.history('project', ep.id, {}, result.history_id);
  assert.deepEqual(history.legacy_scores, [{asset_id: asset.id, scores: {[reverse.id]: before[reverse.id]}}]);

  const snapshot = f.store.backup();
  const target = await setup(t);
  target.projects.remove(target.a.id);
  target.projects.remove(target.b.id);
  await target.store.restore(snapshot);
  assert.deepEqual(withoutToken(target.attrs.getScores(asset.id)), withoutToken(f.attrs.getScores(asset.id)));
  assert.deepEqual(target.attrs.alignment.history('project', ep.id, {}, result.history_id), history);
  assert.deepEqual(target.series.request(result.request_id), {found: true, result});
});

test('A2: a changed score, a generation lock, and a failed receipt never leave a partial alignment', async t => {
  const f = await setup(t), drama = f.makeSeries('失败后保留旧配置', {legacy: true});
  const ep = f.episode(drama);
  const original = f.attrs.getConfig(ep.id);
  const config = f.put(ep, [fresh(original.dimensions[0]), ...original.dimensions.slice(1)]);
  const asset = await f.character(ep, '合成并发人物');
  const view = f.preview(drama);
  f.patch(asset, config.dimensions[0].id, 30);
  assert.throws(() => f.confirm(drama, view), {code: 'ATTRIBUTE_ALIGNMENT_STALE'});
  const next = f.preview(drama), board = new StoryboardDatabase(f.lib, f.store).init(), generation = new GenerationStore(f.lib, board).init();
  const stamp = generation.assetSnapshot(ep.id).assetStamp;
  f.db.prepare('INSERT INTO sb_generation_locks VALUES(?,?,?,?,?)').run(ep.id, randomUUID(), 1, Date.now(), Date.now());
  assert.equal(f.attrs.getConfig(ep.id).config_editable, false);
  assert.equal(f.store.scoped.attributeConfig('series', drama.id).config_editable, false);
  assert.throws(() => f.confirm(drama, next), {status: 423, code: 'STORYBOARD_GENERATION_LOCKED'});
  f.db.prepare('DELETE FROM sb_generation_locks WHERE id=?').run(ep.id);
  f.db.exec(`CREATE TEMP TRIGGER reject_align_receipt BEFORE INSERT ON project_series_requests WHEN NEW.kind='attribute-alignment'
    BEGIN SELECT RAISE(ABORT,'fixture rejected receipt'); END`);
  const requestId = randomUUID();
  assert.throws(() => f.confirm(drama, next, requestId), /fixture rejected receipt/);
  assert.equal(f.attrs.alignment.status(drama.id).status, 'pending');
  assert.equal(f.attrs.getScores(asset.id).scores[config.dimensions[0].id].value, 30);
  assert.deepEqual(f.series.request(requestId), {found: false});
  assert.deepEqual(f.attrs.alignment.history('project', ep.id).items, []);
  assert.equal(generation.assetSnapshot(ep.id).assetStamp, stamp);
  f.db.exec('DROP TRIGGER reject_align_receipt');
  f.confirm(drama, next, requestId);
  const scoped = generation.assetSnapshot(ep.id);
  assert.notEqual(scoped.assetStamp, stamp);
  assert.equal(scoped.scopedAssets.assets[0].attribute_scores[DEFAULT_DIMENSIONS[0].id].value, 30);
});

test('A1/A3: group preview, series removal includes episode scores, exit snapshots the same axis IDs and protects old tokens', async t => {
  const f = await setup(t), drama = f.makeSeries('合成归组剧'), pending = f.makeSeries('待统一剧', {legacy: true});
  const ep = f.a, asset = await f.character(ep, '合成本集人物');
  const staleConfig = f.attrs.getConfig(ep.id);
  const assignment = {request_id: randomUUID(), target: root(drama), items: [item(f, ep, 1)]};
  assert.throws(() => f.series.move(assignment), {code: 'ATTRIBUTE_PREVIEW_REQUIRED'});
  assert.throws(() => f.series.move({...assignment, target: root(pending)}), {code: 'ATTRIBUTE_ALIGNMENT_REQUIRED'});
  const moved = moveWithAttributePlan(f.series, assignment);
  assert.equal(moved.can_undo, false);
  assert.equal(moved.attribute_history_ids.length, 1);
  assert.throws(() => f.series.undo(moved.request_id, {request_id: randomUUID()}), {code: 'SERIES_UNDO_CONFLICT'});
  const [first, second] = f.attrs.getConfig(ep.id).dimensions;
  f.patch(asset, first.id, null);
  f.patch(asset, second.id, 30);

  const attrs = f.store.attributes, w = f.store.scopedWrites, s = f.store.scoped;
  const seriesConfig = s.attributeConfig('series', drama.id);
  const context_token = s.scope('series', drama.id).context_token;
  const payload = {request_id: randomUUID(), config_token: seriesConfig.config_token,
    context_token, expected_revision: seriesConfig.revision, dimensions: seriesConfig.dimensions.slice(1)};
  assert.throws(() => w.patchConfig('series', drama.id, {...payload, config_token: staleConfig.config_token}), {code: 'ATTRIBUTE_CONTEXT_STALE'});
  assert.throws(() => w.patchConfig('series', drama.id, payload), {code: 'DIMENSION_REMOVAL_CONFIRM'});
  const preview = w.configRemovalPreview('series', drama.id, {...payload, remove: [first.id]});
  assert.equal(preview.affected[0].scored_assets, 1);
  w.patchConfig('series', drama.id, {...payload, removal_confirmation: {token: preview.token}});
  assert.equal(Object.hasOwn(attrs.getScores(asset.id).scores, first.id), false);
  const inside = attrs.getConfig(ep.id), beforeExit = attrs.getScores(asset.id);
  const exit = moveWithAttributePlan(f.series, {request_id: randomUUID(), target: emptyTarget, items: [item(f, ep)]});
  const outside = attrs.getConfig(ep.id);
  assert.equal(exit.can_undo, false);
  assert.deepEqual(outside.dimensions, inside.dimensions);
  assert.deepEqual(attrs.getScores(asset.id).scores, beforeExit.scores);
  assert.throws(() => attrs.patchScores(asset.id, {project_id: ep.id,
    expected_config_revision: outside.revision, expected_attribute_revision: beforeExit.attribute_revision,
    changes: [{dimension_id: second.id, value: 55}]}), {code: 'ATTRIBUTE_CONTEXT_STALE'});
  assert.throws(() => attrs.patchScores(asset.id, {project_id: ep.id, config_token: inside.config_token,
    expected_config_revision: outside.revision, expected_attribute_revision: beforeExit.attribute_revision,
    changes: [{dimension_id: second.id, value: 55}]}), {code: 'ATTRIBUTE_CONTEXT_STALE'});
  assert.equal(f.patch(asset, second.id, 55).scores[second.id].value, 55);
  assert.throws(() => attrs.alignment.history('series', drama.id, {}, exit.attribute_history_ids[0]), {code: 'ATTRIBUTE_HISTORY_NOT_FOUND'});
  assert.equal(attrs.alignment.history('project', ep.id, {}, exit.attribute_history_ids[0]).kind, 'series_exit');
});

test('A3: batch preview uses a stable new-series group ID, copies its selected baseline and does not commit stale plans', async t => {
  const f = await setup(t);
  const d = f.attrs.getConfig(f.b.id).dimensions;
  const custom = f.put(f.b, [fresh({...d[0], name: '合成定制轴'}), ...d.slice(1)]);
  const asset = await f.character(f.b, '合成待归组');
  const input = {request_id: randomUUID(), groups: [{group_id: 'new-series',
    target: {new_series: {name: '新建时复制集维度'}}, items: [item(f, f.b, 1)]}]};
  const plan = f.series.previewOrganize(input);
  assert.equal(plan.changes[0].after.series_id, null);
  assert.deepEqual(plan.attribute_plan.groups[0].baseline, {kind: 'episode', project_id: f.b.id});
  assert.deepEqual(f.series.list(), []);
  const confirmed = confirmAttributePlan(f.series, 'organize', input);
  f.patch(asset, custom.dimensions[0].id, 20);
  assert.throws(() => f.series.organize(confirmed), {code: 'ATTRIBUTE_ALIGNMENT_STALE'});
  assert.deepEqual(f.series.list(), []);
  const update = confirmAttributePlan(f.series, 'organize', input), done = f.series.organize(update);
  const id = done.created_series[0].series.id;
  assert.deepEqual(f.series.organize(update), done);
  assert.equal(f.attrs.alignment.status(id).status, 'aligned');
  assert.equal(f.attrs.getConfig(f.b.id).dimensions[0].id, custom.dimensions[0].id);
  assert.equal(f.attrs.getScores(asset.id).scores[custom.dimensions[0].id].value, 20);
  assert.doesNotThrow(() => f.store.validateBackup(f.store.backup()));
});

test('A2/A4: live route shapes on an isolated SQLite server', async t => {
  const f = await setup(t), drama = f.makeSeries('合成路由旧剧', {legacy: true}), ep = f.episode(drama);
  const app = express();
  app.use(express.json());
  app.use('/api', projectSeriesRouter(f.series));
  app.use('/api/project-assets', projectAssetRouter(f.store, fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next)));
  app.use((error, _req, res, _next) => res.status(error.status ?? 500).json({error: error.message, code: error.code, details: error.details}));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  const api = async (path, body) => {
    const res = await fetch('http://127.0.0.1:' + server.address().port + '/api' + path, body === undefined ? {} :
      {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
    return {status: res.status, data: await res.json()};
  };
  const base = '/project-series/' + drama.id + '/attribute-alignment';
  assert.equal((await api(base)).data.status, 'pending');
  const {data: plan} = await api(base + '/preview', {expected_alignment_revision: 0});
  const request_id = randomUUID();
  const {status, data: receipt} = await api(base + '/confirm', {request_id, preview_token: plan.preview_token, choices: plan.choices});
  assert.equal(status, 200);
  assert.deepEqual((await api('/project-series/requests/' + request_id)).data, {found: true, result: receipt});
  const projectPath = '/project-assets/projects/' + ep.id;
  assert.equal((await api(projectPath + '/attribute-config')).data.config_scope, 'series');
  assert.equal((await api(projectPath + '/attribute-history/' + receipt.history_id)).data.request_id, request_id);
});

test('A2: unknown legacy score keys are retained verbatim and can be backed up', async t => {
  const f = await setup(t), drama = f.makeSeries('合成异常旧键', {legacy: true}), ep = f.episode(drama);
  const asset = await f.character(ep, '合成异常评分人物');
  const opaque = {value: 0, source: 'manual', reason: null, updated_at: 10};
  f.db.prepare('INSERT INTO project_character_attributes VALUES(?,?,?,?)')
    .run(asset.id, ep.id, 1, JSON.stringify({['__proto__']: opaque}));
  const view = f.preview(drama);
  const decision = view.episodes[0].decisions[0];
  assert.equal(decision.reason, 'unknown_score_key');
  assert.deepEqual(decision.allowed_actions, ['retain_legacy']);
  const done = f.confirm(drama, view);
  assert.deepEqual(f.attrs.getScores(asset.id).scores, {});
  const history = f.attrs.alignment.history('project', ep.id, {}, done.history_id);
  assert.deepEqual(history.legacy_scores[0].scores, {['__proto__']: opaque});
  assert.doesNotThrow(() => f.store.validateBackup(f.store.backup()));
});

test('A3: different groups entering the same series share one dimension-limit calculation and one stored addition', async t => {
  const f = await setup(t), drama = f.makeSeries('合成并行目标');
  const custom = fresh({name: '新合成轴', negative_label: '退缩', positive_label: '迎难', neutral_label: '观察', criterion: '行为依据'});
  const aConfig = f.put(f.a, [...DEFAULT_DIMENSIONS, custom]), bConfig = f.put(f.b, [...DEFAULT_DIMENSIONS, custom]);
  const a = await f.character(f.a, '合成甲'), b = await f.character(f.b, '合成乙');
  f.patch(a, aConfig.dimensions.at(-1).id, 20);
  f.patch(b, bConfig.dimensions.at(-1).id, 50);
  const input = {request_id: randomUUID(), groups: [
    {group_id: 'first', target: root(drama), items: [item(f, f.a, 1)]},
    {group_id: 'second', target: root(drama), items: [item(f, f.b, 2)]},
  ]};
  const first = f.series.previewOrganize(input);
  const attribute_choices = first.attribute_plan.groups.map(group => ({group_id: group.group_id,
    decisions: [{item_id: group.alignment.episodes[0].decisions[0].item_id, action: 'add_to_series'}]}));
  const plan = f.series.previewOrganize({...input, attribute_choices});
  const axis = plan.attribute_plan.groups[0].alignment.series_changes.added[0].dimension.id;
  assert.equal(plan.attribute_plan.groups[1].alignment.series_changes.added[0].dimension.id, axis);
  assert.equal(plan.attribute_plan.groups[0].alignment.series_changes.added[0].impact.people, 2);
  const done = f.series.organize({...input, attribute_choices: plan.attribute_plan.choices, attribute_preview_token: plan.attribute_plan.preview_token});
  assert.equal(done.attribute_history_ids.length, 1);
  assert.equal(f.attrs.getConfig(f.a.id).dimensions.length, 7);
  assert.equal(f.attrs.getScores(a.id).scores[axis].value, 20);
  assert.equal(f.attrs.getScores(b.id).scores[axis].value, 50);
  const broken = f.store.backup();
  broken.project_attributes.project_attribute_history = broken.project_attributes.project_attribute_history
    .filter(row => row.history_id !== done.attribute_history_ids[0] || row.project_id !== f.a.id);
  const {format, schema_version, checksum, ...contents} = broken;
  broken.checksum = digest(contents);
  await assert.rejects(f.store.restore(broken), /人物属性备份记录无效/);

});

test('A4: restore rejects transplanted history and success receipts stripped of their evidence', async t => {
  const f = await setup(t), drama = f.makeSeries('合成历史归属', {legacy: true}), ep = f.episode(drama);
  const asset = await f.character(ep, '合成受保护人物');
  const configured = f.put(ep, [{...DEFAULT_DIMENSIONS[0], criterion: '不兼容的旧依据'}, ...DEFAULT_DIMENSIONS.slice(1)]);
  f.patch(asset, configured.dimensions[0].id, 42);
  const receipt = f.confirm(drama, f.preview(drama));
  const snapshot = f.store.backup();
  const change = apply => {
    const draft = structuredClone(snapshot);
    apply(draft);
    const {format, schema_version, checksum, ...contents} = draft;
    draft.checksum = digest(contents);
    return draft;
  };
  const row = draft => draft.project_attributes.project_attribute_history.find(entry => entry.project_id === ep.id);
  const first = change(draft => { row(draft).project_id = f.b.id; });
  const second = change(draft => {
    const entry = row(draft);
    const data = JSON.parse(entry.data_json);
    entry.project_id = f.b.id;
    data.before_configs[0].project_id = f.b.id;
    data.before_configs[0].config_owner_id = f.b.id;
    entry.data_json = JSON.stringify(data);
  });
  const third = change(draft => {
    draft.project_attributes.series_attribute_alignment = [];
    draft.project_attributes.project_attribute_history = [];
  });
  const fourth = change(draft => { delete draft.project_attributes; });
  const fifth = change(draft => {
    const entry = row(draft), data = JSON.parse(entry.data_json);
    data.legacy_scores = [];
    entry.data_json = JSON.stringify(data);
  });
  for (const invalid of [first, second, third, fourth, fifth]) {
    await assert.rejects(f.store.restore(invalid), /人物属性备份记录无效/);
  }
  assert.equal(f.attrs.alignment.history('project', f.b.id).items.length, 0);
  assert.deepEqual(f.series.request(receipt.request_id), {found: true, result: receipt});
  assert.equal(f.attrs.alignment.history('project', ep.id, {}, receipt.history_id).legacy_scores[0].scores[configured.dimensions[0].id].value, 42);
});

test('A1: adding an episode invalidates a previous series removal confirmation even without new scores', async t => {
  const f = await setup(t), drama = f.makeSeries('合成删轴目标'), ep = f.episode(drama);
  const asset = await f.character(ep, '合成已有评分');
  const first = f.attrs.getConfig(ep.id).dimensions[0];
  f.patch(asset, first.id, 42);
  const writes = f.store.scopedWrites, scoped = f.store.scoped;
  const context_token = scoped.scope('series', drama.id).context_token;
  const {config_token, revision, dimensions} = scoped.attributeConfig('series', drama.id);
  const request = {context_token, config_token, expected_revision: revision};
  const preview = writes.configRemovalPreview('series', drama.id, {...request, remove: [first.id]});
  const incoming = f.episode(drama, 2);
  assert.throws(() => writes.patchConfig('series', drama.id, {...request, request_id: randomUUID(),
    dimensions: dimensions.slice(1), removal_confirmation: {token: preview.token}}), {code: 'REMOVAL_PREVIEW_STALE'});
  assert.equal(f.attrs.getScores(asset.id).scores[first.id].value, 42);
  assert.equal(f.attrs.getConfig(incoming.id).dimensions[0].id, first.id);
});


test('A3: a storyboard lock starting after preview returns the existing 423 and does not move the project', async t => {
  const f = await setup(t), drama = f.makeSeries('合成生成锁归组');
  const board = new StoryboardDatabase(f.lib, f.store).init();
  new GenerationStore(f.lib, board).init();
  const assignment = confirmAttributePlan(f.series, 'move', {
    request_id: randomUUID(), target: root(drama), items: [item(f, f.a, 1)],
  });
  f.db.prepare('INSERT INTO sb_generation_locks VALUES(?,?,?,?,?)').run(f.a.id, randomUUID(), 1, Date.now(), Date.now());
  assert.throws(() => f.series.move(assignment), {status: 423, code: 'STORYBOARD_GENERATION_LOCKED'});
  assert.equal(f.series.membership(f.a.id).series_id, null);
  assert.deepEqual(f.series.request(assignment.request_id), {found: false});
});
