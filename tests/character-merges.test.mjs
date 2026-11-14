import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { creativeFixture, addLook, addImage } from './helpers/creative-fixture.mjs';
import { assertCharacterMergeRequestRace } from './helpers/character-merge-request-race.mjs';
import express from 'express';
import { once } from 'node:events';
import { StoryboardDatabase } from '../server/storyboard/database.mjs';
import { GenerationStore } from '../server/storyboard-generation/store.mjs';
import { emptyShot, validateProject } from '../server/storyboard/shared/model.mjs';
import { syntheticSource } from './helpers/storyboard-fixture.mjs';
import { projectSeriesRouter } from '../server/project-series/router.mjs';
import { canonical, digest } from '../server/project-assets/model.mjs';

async function setup(t) {
  const f = await creativeFixture();
  t.after(f.close);
  const series = f.projects.series;
  const drama = series.createSeries({ request_id: randomUUID(), name: '合成剧' });
  const episode = () => series.createEpisode(drama.id, { request_id: randomUUID(), season_id: null,
    expected_episode_no: series.list().find(row => row.id === drama.id).next_episode_no }).project;
  const first = episode(), second = episode();
  const svc = f.store.characterMerges, writes = f.store.scopedWrites;
  const character = async (project, { look = false, name = '同名人物' } = {}) => {
    const asset = await f.store.create({ project_id: project.id, kind: 'character', name });
    if (!look) return asset;
    addLook(asset);
    addImage(asset, f.media);
    asset.base_info = '合成原资料';
    return f.store.save(asset.id, asset, asset.revision);
  };
  const context = () => svc.groups(drama.id).context_token;
  const preview = (primary, choices) => svc.preview(drama.id, {
    group_id: svc.groups(drama.id).items[0].group_id, primary_asset_id: primary.id,
    context_token: context(), ...(choices ? { choices } : {}),
  });
  const commit = (view, request_id = randomUUID()) => svc.confirm(drama.id, {
    request_id, context_token: context(), preview_token: view.preview_token, choices: view.choices,
  });
  const undo = (mergeId, view, accept_restore_changes = false) => svc.undo(drama.id, mergeId, {
    request_id: randomUUID(), context_token: context(), undo_token: view.undo_token, accept_restore_changes,
  });
  const undoPreview = mergeId => svc.undoPreview(drama.id, mergeId, { context_token: context() });
  return { ...f, drama, first, second, series, svc, writes, context, character, preview, commit, undo, undoPreview };
}

test('cross-episode discovery does not block creation, and a shared primary is locked', async t => {
  const f = await setup(t), a = await f.character(f.first);
  const hint = f.writes.checkNames('episode', f.second.id, { kind: 'character', name: a.name });
  assert.equal(hint.status, 'available');
  assert.equal(hint.related_characters.action, 'promote');
  assert.equal(hint.related_characters.promotion_project_id, f.first.id);
  const b = await f.character(f.second);
  assert.equal(f.svc.groups(f.drama.id).summary.group_count, 1);
  assert.equal(f.writes.checkNames('episode', f.second.id, { kind: 'character', name: a.name }).related_characters.action, 'merge');
  f.db.prepare("UPDATE creative_assets SET owner_type='series',owner_id=?,project_id=NULL WHERE id=?").run(f.drama.id, a.id);
  const locked = f.svc.groups(f.drama.id).items[0].members;
  assert.equal(locked.find(row => row.asset_id === a.id).primary_locked, true);
  assert.throws(() => f.preview(b), { code: 'CHARACTER_MERGE_PRIMARY_REQUIRED' });
  assert.equal(f.preview(a).members.find(row => row.asset_id === b.id).primary_locked, false);
});

test('merge is atomic and repeatable, keeps photo IDs, preserves the source representative and undoes with new revisions', async t => {
  const f = await setup(t), a = await f.character(f.first, {look:true}), b = await f.character(f.second, {look:true});
  const dim = f.store.attributes.getConfig(f.second.id).dimensions[0].id;
  const score = { value: 55, source: 'ai', reason: '合成依据', updated_at: 77 };
  f.db.prepare('INSERT INTO project_character_attributes VALUES(?,?,1,?)').run(b.id, f.second.id, canonical({ [dim]: score }));
  const initial = f.preview(a), conflict = initial.look_plan.conflicts[0];
  assert.equal(initial.text_plan.other_sources[0].base_info, '合成原资料');
  assert.match(conflict.suggested_name, /第2集/);
  const view = f.preview(a, {look_choices:[{conflict_id: conflict.conflict_id, action:'merge_into', target_look_id:a.default_look_id}]});
  assert.equal(view.ready, true);
  const req = randomUUID(), result = f.commit(view, req);
  assert.deepEqual(f.commit(view, req), result);
  assert.equal(f.svc.request(f.drama.id, req).result.canonical_asset_id, a.id);
  assert.equal(f.svc.resolveAsset(f.second.id, b.id), a.id);
  assert.equal(f.svc.resolveAsset(f.a.id, b.id), b.id);
  assert.equal(f.svc.resolveLook(f.second.id, b.default_look_id), a.default_look_id);
  const second = f.store.scoped.detail('episode', f.second.id, b.id);
  assert.equal(second.resolution.canonical_asset_id, a.id);
  assert.equal(second.effective.default_images[a.default_look_id].value, b.images[0].id);
  assert.equal(f.store.get(a.id).looks[0].default_image_id, a.images[0].id);
  assert.deepEqual(second.effective.attribute_scores[dim].value, {...score, source_asset_id:b.id, merge_id:result.merge_id});
  assert.equal(f.store.scoped.list('episode', f.second.id, {archived:'true'}).total, 0);
  assert.equal(f.store.scoped.versions('series', f.drama.id, a.id)[0].kind, 'character_merge');
  assert.equal(f.store.validateBackup(f.store.backup()).tables.creative_character_aliases.length, 1);
  const target = await creativeFixture();
  t.after(target.close);
  target.projects.save(target.a.id, { name: '目标夹具甲' });
  target.projects.save(target.b.id, { name: '目标夹具乙' });
  await target.store.restore(f.store.backup());
  assert.equal(target.store.characterMerges.resolveAsset(f.second.id, b.id), a.id);
  const undo = f.undoPreview(result.merge_id);
  assert.equal(undo.status, 'clean');
  const undone = f.undo(result.merge_id, undo);
  assert.equal(undone.status, 'undone');
  assert.equal(f.store.get(a.id).project_id, f.first.id);
  assert.equal(f.store.get(b.id).images[0].id, b.images[0].id);
  assert(f.store.get(b.id).revision > b.revision + 1);
  assert.equal(f.svc.resolveAsset(f.second.id, b.id), b.id);
  assert.equal(f.svc.request(f.drama.id, req).result.can_undo, false);
  assert.equal(f.store.validateBackup(f.store.backup()).tables.creative_character_aliases.length, 0);
});

test('stale input, a generation lock, and a failed receipt leave no partial writes', async t => {
  const f = await setup(t), a = await f.character(f.first), b = await f.character(f.second);
  const stale = f.preview(a);
  await f.store.save(b.id, {...b, base_info:'预览后补充'}, b.revision);
  assert.throws(() => f.commit(stale), { code:'CHARACTER_MERGE_STALE' });
  const view = f.preview(a);
  f.store.generationLocks = { assertWritable(id) {
    if (id === f.second.id) throw Object.assign(Error('生成中'), {status:423,code:'STORYBOARD_GENERATION_LOCKED'});
  } };
  assert.throws(() => f.commit(view), {status:423});
  f.store.generationLocks = null;
  const before = f.store.backup().checksum;
  f.db.exec("CREATE TRIGGER fail_character_merge_receipt BEFORE INSERT ON creative_character_merge_requests BEGIN SELECT RAISE(ABORT, 'synthetic refusal'); END");
  assert.throws(() => f.commit(view), /synthetic refusal/);
  assert.equal(f.store.backup().checksum, before);
  f.db.exec('DROP TRIGGER fail_character_merge_receipt');
  const result = f.commit(view);
  assert.equal(result.can_undo, true);
});

test('undo retains unrelated text edits, rejects tampered backup, and refuses to overwrite changed covered fields silently', async t => {
  const f = await setup(t), a = await f.character(f.first, {look:true}), b = await f.character(f.second, {look:true});
  const result = f.commit(f.preview(a));
  const target = f.store.get(a.id);
  const save = value => f.writes.save('series', f.drama.id, target.id, {
    request_id: randomUUID(), context_token: f.context(), expected_revision: target.revision, asset: value,
  });
  const updated = {...target, performance_info:'合并后的补充'};
  updated.looks.find(look => look.id === b.default_look_id).description = '保留新造型说明';
  await save(updated);
  const episode = f.store.scoped.detail('episode', f.second.id, target.id);
  f.writes.setOverride('episode', f.second.id, target.id, { request_id: randomUUID(),
    context_token: episode.context_token, field:{key:'default_look'}, action:'set',
    value:a.default_look_id, write_token:episode.effective.default_look.write_token });
  const undo = f.undoPreview(result.merge_id);
  assert.equal(undo.status, 'review_required');
  assert(undo.changes.some(change => change.action === 'preserve'));
  assert(undo.changes.some(change => change.action === 'restore_with_confirmation'));
  assert.throws(() => f.undo(result.merge_id, undo), {code:'CHARACTER_MERGE_UNDO_BLOCKED'});
  const backup = f.store.backup();
  backup.tables.creative_character_aliases[0].target_id = randomUUID();
  const {format:_format,schema_version:_version,checksum:_checksum,...content} = backup;
  backup.checksum = digest(content);
  assert.throws(() => f.store.validateBackup(backup), /备份中包含无效/);
  f.undo(result.merge_id, undo, true);
  assert.equal(f.store.get(a.id).performance_info, '合并后的补充');
  assert.equal(f.store.get(b.id).looks[0].description, '保留新造型说明');
  assert.equal(f.store.get(b.id).looks[0].name, b.looks[0].name);
});

test('an episode with no local look stays explicitly empty and stale scopes cannot write the alias', async t => {
  const f = await setup(t), a = await f.character(f.first, {look:true}), b = await f.character(f.second);
  const view = f.preview(a);
  assert.equal(view.default_look_plan.find(row => row.source_asset_id === b.id).mode, 'explicit_empty');
  const result = f.commit(view);
  assert.equal(f.store.scoped.detail('episode', f.second.id, a.id).effective.default_look.override.value, null);
  const scope = f.store.scoped.scope('episode', f.second.id);
  assert.throws(() => f.writes.setOverride('episode', f.second.id, b.id, {
    request_id:randomUUID(), context_token:scope.context_token, field:{key:'default_look'}, action:'set', value:a.default_look_id,
  }), {code:'ASSET_MERGED'});
  assert.throws(() => f.store.scoped.detail('episode', f.a.id, b.id), {status:404});
  assert.throws(() => f.store.copyPreview(b.id, f.a.id, f.a.id), {status:404});
  const copy = f.store.copyPreview(b.id, f.a.id, f.second.id);
  assert.equal(copy.source.id, a.id);
  assert.equal(copy.resolution.canonical_asset_id, a.id);
  const saved = f.store.copy(a.id, {request_id:copy.request_id, source_project_id:f.second.id,
    project_id:f.a.id, source_revision:copy.source_revision, name:'合成独立副本'});
  assert.notEqual(saved.id, a.id);
  assert.notEqual(saved.images[0].id, a.images[0].id);
  assert.equal(saved.images[0].media_asset_id, a.images[0].media_asset_id);
  f.undo(result.merge_id, f.undoPreview(result.merge_id));
});

test('old dialogue and manifest links remain byte-stable through merge, then reject new alias uses', async t => {
  const f = await setup(t);
  const a = await f.character(f.first, {look:true, name:'陈川'});
  const b = await f.character(f.second, {look:true, name:'陈川'});
  const board = new StoryboardDatabase(f.lib, f.store).init();
  const initial = board.initialize(f.second.id, {source:syntheticSource(), request_id:randomUUID(), expected_revision:null});
  const project = structuredClone(initial.project), scene = project.scenes[0], speaker = scene.shots[0];
  speaker.character_presence = [{character_id:b.id, look_id:b.default_look_id, mode:"visible"}];
  const reaction = emptyShot();
  reaction.audio_continuations = [{source_shot_id:speaker.id, dialogue_id:speaker.dialogue[0].id,note:"承接"}];
  scene.shots.push(reaction);
  assert.deepEqual(validateProject(project), []);
  board.save(f.second.id, {project, expected_revision:initial.revision});
  const original = board.head(f.second.id);
  const links = f.db.prepare('SELECT * FROM storyboard_asset_links ORDER BY id').all();
  assert.equal(initial.project.scenes[0].shots[0].dialogue[0].character_id, b.id);
  const conflict = f.preview(a).look_plan.conflicts[0];
  const preview = f.preview(a, {look_choices:[{conflict_id:conflict.conflict_id,
    action:'merge_into', target_look_id:a.default_look_id}]});
  assert.equal(preview.reference_plan.shots, 2);
  const merge = f.commit(preview);
  assert.deepEqual(board.head(f.second.id), original);
  assert.deepEqual(f.db.prepare('SELECT * FROM storyboard_asset_links ORDER BY id').all(), links);
  const read = board.read(f.second.id);
  assert.equal(read.project.characters[0].id, b.id);
  assert.equal(read.asset_resolution[b.id].canonical_asset_id, a.id);
  assert.equal(read.canonical_asset_manifest.character[0].id, a.id);
  assert.equal(read.look_resolution[b.default_look_id].canonical_look_id, a.default_look_id);
  const associations = board.assetShots(a.id, f.second.id).items;
  assert.equal(associations[0].reasons.includes('对白'), true);
  assert.equal(associations[1].reasons.includes('语音承接'), true);
  const gen = new GenerationStore(f.lib, board).init();
  assert.equal(gen.assetSnapshot(f.second.id).storyboardReferences.asset_resolution[b.id].canonical_asset_id, a.id);
  assert.equal(board.validateBackup(board.backup()).creative.tables.creative_character_aliases.length, 1);
  const originalProject = structuredClone(read.project);
  originalProject.scenes[0].shots[0].action += ' 只更新动作。';
  const edit = board.save(f.second.id, {project:originalProject, expected_revision:read.revision});
  assert.equal(edit.project.scenes[0].shots[0].dialogue[0].character_id, b.id);
  const bad = structuredClone(edit.project);
  const shot = bad.scenes[0].shots[0];
  shot.dialogue.push({...shot.dialogue[0], id:'new-dialogue'});
  assert.throws(() => board.save(f.second.id, {project:bad, expected_revision:edit.revision}), {code:'ASSET_MERGED'});
  const valid = structuredClone(edit.project);
  valid.asset_manifest.character.push({id:a.id,name:a.name});
  valid.characters.push({...valid.characters[0],id:a.id});
  board.save(f.second.id, {project:valid, expected_revision:edit.revision});
  assert(f.undoPreview(merge.merge_id).blockers.some(blocker => blocker.code === 'CHARACTER_MERGE_NEW_REFERENCE'));
});

test('series HTTP contract supports durable request lookup and reports alignment before writing', async t => {
  const f = await setup(t), a = await f.character(f.first), b = await f.character(f.second);
  const app = express();
  app.use(express.json(), projectSeriesRouter(f.series));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port + '/project-series/' + f.drama.id;
  const api = async (path, payload) => {
    const response = await fetch(origin + path, payload === undefined ? {} :
      {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(payload)});
    return {status:response.status, result:await response.json()};
  };
  const groups = (await api('/character-merge-groups')).result;
  assert.equal(groups.items[0].members.length, 2);
  const input = {group_id:groups.items[0].group_id, primary_asset_id:a.id, context_token:groups.context_token};
  const preview = await api('/character-merges/preview', input);
  assert.equal(preview.result.ready, true);
  f.db.prepare('DELETE FROM series_attribute_alignment WHERE id=?').run(f.drama.id);
  const inputCommit = {request_id:randomUUID(), context_token:groups.context_token,
    preview_token:preview.result.preview_token, choices:preview.result.choices};
  const rejected = await api('/character-merges/confirm', inputCommit);
  assert.equal(rejected.status, 409);
  assert.equal(rejected.result.code, 'ATTRIBUTE_ALIGNMENT_REQUIRED');
  assert.deepEqual(rejected.result.details, {request_settled:true});
  assert.deepEqual(await api('/character-merge-requests/' + inputCommit.request_id), {
    status:200, result:{found:true, result:{request_id:inputCommit.request_id, status:'rejected',
      code:rejected.result.code, message:rejected.result.error}},
  });
  assert.equal(f.store.get(b.id).archived_at, 0);
  f.store.attributes.alignment.markAligned(f.drama.id);
  assert.deepEqual(await api('/character-merges/confirm', inputCommit), rejected);
  const commit = {...inputCommit, request_id:randomUUID()};
  const confirmed = await api('/character-merges/confirm', commit);
  assert.equal(confirmed.status, 200);
  assert.deepEqual(await api('/character-merges/confirm', commit), confirmed);
  assert.equal((await api('/character-merge-requests/' + commit.request_id)).result.result.merge_id, confirmed.result.merge_id);
  assert.deepEqual(await api('/character-merges/confirm', {...commit, preview_token:'different'}), {
    status:409, result:{code:'REQUEST_ID_CONFLICT', error:'请求编号已用于不同操作'},
  });
});

test('a shared primary preserves its score and unrelated overrides while a source clear wins on its own cell', async t => {
  const f = await setup(t), a = await f.character(f.first), b = await f.character(f.second);
  const dims = f.store.attributes.getConfig(f.first.id).dimensions;
  const dimsByIndex = dims.map(row => row.id);
  const [first, second] = dimsByIndex;
  const manual = value => ({value,source:'manual',reason:null,updated_at:12});
  const scores = f.db.prepare('INSERT INTO series_character_attributes VALUES(?,?,?,?,?,?)');
  f.db.prepare("UPDATE creative_assets SET owner_type='series',owner_id=?,project_id=NULL WHERE id=?").run(f.drama.id, a.id);
  scores.run(a.id, f.drama.id, 1, canonical({[first]:manual(80)}), 12, 12);
  f.db.prepare('INSERT INTO project_character_attributes VALUES(?,?,1,?)').run(b.id, f.second.id, canonical({[first]:manual(null)}));
  for (const dim of [first, second]) {
    const item = f.store.scoped.detail('episode', f.second.id, a.id);
    f.writes.setOverride('episode', f.second.id, a.id, {request_id:randomUUID(), context_token:item.context_token,
      field:{key:'attribute_score',dimension_id:dim}, action:'set', value:{value:42},
      write_token:item.effective.attribute_scores[dim].write_token});
  }
  const view = f.preview(a);
  assert.equal(view.score_plan.existing_overrides_preserved, 1);
  assert.equal(view.score_plan.override_conflicts[0].dimension_id, first);
  const result = f.commit(view);
  const effective = () => f.store.scoped.detail('episode', f.second.id, a.id).effective.attribute_scores;
  assert.equal(effective()[first].value.value, null);
  assert.equal(effective()[second].value.value, 42);
  assert.equal(f.store.scoped.attributeScores('series', f.drama.id, a.id).scores[first].value, 80);
  f.undo(result.merge_id, f.undoPreview(result.merge_id));
  assert.equal(effective()[first].value.value, 42);
});

test('two SQLite connections serialize the same request after either terminal result commits', async t => {
  const f = await creativeFixture({onDisk:true});
  t.after(f.close);
  const options = {filename:f.db.name};
  await assertCharacterMergeRequestRace(f.store, options, false);
  await assertCharacterMergeRequestRace(f.store, options, true);
});

test('temporary migration and generation locks and failed rejection writes leave the original request available', async t => {
  const f = await setup(t), a = await f.character(f.first), b = await f.character(f.second);
  const view = f.preview(a), requestId = randomUUID();
  const before = f.store.backup().checksum;
  const unknown = () => assert.deepEqual(f.svc.request(f.drama.id, requestId), {found:false});
  const transient = error => error.status === 423 && !error.details?.request_settled;
  f.lib.migrating = true;
  assert.throws(() => f.commit(view, requestId), transient);
  f.lib.migrating = false;
  unknown();
  f.store.generationLocks = { assertWritable() {
    throw Object.assign(Error('夹具生成中'), {status:423, code:'STORYBOARD_GENERATION_LOCKED'});
  } };
  assert.throws(() => f.commit(view, requestId), transient);
  f.store.generationLocks = null;
  unknown();
  f.db.exec('DELETE FROM series_attribute_alignment');
  f.db.exec("CREATE TRIGGER fail_rejected_receipt BEFORE INSERT ON creative_character_merge_requests BEGIN SELECT RAISE(ABORT, 'rejection storage failed'); END");
  assert.throws(() => f.commit(view, requestId), error => /rejection storage failed/.test(error.message) && !error.details?.request_settled);
  unknown();
  f.db.exec('DROP TRIGGER fail_rejected_receipt');
  f.store.attributes.alignment.markAligned(f.drama.id);
  assert.equal(f.store.backup().checksum, before);
  assert.equal(f.commit(view, requestId).status, 'merged');
  assert.ok(f.store.get(b.id).archived_at > 0);
});

test('only well-formed business failures settle and preserve original HTTP statuses and details', async t => {
  const f = await setup(t), a = await f.character(f.first, {look:true}), b = await f.character(f.second, {look:true});
  const view = f.preview(a);
  const input = {request_id:randomUUID(), context_token:f.context(), preview_token:view.preview_token, choices:view.choices};
  const confirm = value => f.svc.confirm(f.drama.id, value);
  for (const changes of [
    {preview_token:'malformed'}, {context_token:null}, {choices:{}},
    {choices:{look_choices:[{conflict_id:view.look_plan.conflicts[0].conflict_id, action:'invented'}]}},
  ]) {
    assert.throws(() => confirm({...input, ...changes}), {status:422, code:'CHARACTER_MERGE_INVALID_INPUT'});
    assert.deepEqual(f.svc.request(f.drama.id, input.request_id), {found:false});
  }
  const illegalTarget = {...input, request_id:randomUUID(), choices:{look_choices:[
    {conflict_id:view.look_plan.conflicts[0].conflict_id, action:'merge_into', target_look_id:randomUUID()},
  ]}};
  const choiceError = {status:422, code:'CHARACTER_MERGE_CHOICE_INVALID', details:{request_settled:true}};
  assert.throws(() => confirm(illegalTarget), choiceError);
  assert.throws(() => confirm(illegalTarget), choiceError);
  const merge = confirm(input);
  assert.throws(() => confirm({request_id:input.request_id}), {code:'REQUEST_ID_CONFLICT'});
  const clean = f.undoPreview(merge.merge_id);
  const undo = {request_id:randomUUID(), context_token:f.context(), undo_token:clean.undo_token, accept_restore_changes:false};
  const submitUndo = (input, id = merge.merge_id) => f.svc.undo(f.drama.id, id, input);
  assert.throws(() => submitUndo(undo, randomUUID()), {status:404, code:'CHARACTER_MERGE_NOT_FOUND'});
  assert.deepEqual(f.svc.request(f.drama.id, undo.request_id), {found:false});
  const stale = {...undo, request_id:randomUUID(), undo_token:'0'.repeat(64)};
  assert.throws(() => submitUndo(stale), {status:409, code:'CHARACTER_MERGE_UNDO_STALE', details:{request_settled:true}});
  const board = new StoryboardDatabase(f.lib, f.store).init();
  const source = syntheticSource();
  source.characters[0].name = source.asset_manifest.character[0].name = a.name;
  board.initialize(f.second.id, {source, request_id:randomUUID(), expected_revision:null});
  const blocked = f.undoPreview(merge.merge_id);
  assert.equal(blocked.status, 'blocked');
  const code = 'CHARACTER_MERGE_UNDO_BLOCKED';
  const message = '存在不能安全恢复的引用或后续操作';
  const details = {blockers:blocked.blockers};
  assert.throws(() => submitUndo(undo), {status:409, code, message, details:{...details, request_settled:true}});
  assert.throws(() => submitUndo(undo), {status:409, code, message, details:{...details, request_settled:true}});
  assert.deepEqual(f.svc.request(f.drama.id, undo.request_id), {
    found:true, result:{request_id:undo.request_id, status:'rejected', code, message, details},
  });
  assert.equal(f.store.get(b.id).archived_at > 0, true);
});


test('old and mixed backup receipts restore, and invalid rejected receipt shapes fail validation', async t => {
  const f = await setup(t), a = await f.character(f.first), b = await f.character(f.second);
  const view = f.preview(a), merged = f.commit(view);
  const oldBackup = f.store.backup();
  const rejectInput = {request_id:randomUUID(), context_token:f.context(), preview_token:view.preview_token, choices:view.choices};
  assert.throws(() => f.svc.confirm(f.drama.id, rejectInput), {
    status:409, code:'CHARACTER_MERGE_STALE', details:{request_settled:true},
  });
  const undone = f.undo(merged.merge_id, f.undoPreview(merged.merge_id));
  const mixedBackup = f.store.backup();
  const restore = async backup => {
    const target = await creativeFixture();
    t.after(target.close);
    target.projects.save(target.a.id, {name:'备份目标甲'});
    target.projects.save(target.b.id, {name:'备份目标乙'});
    await target.store.restore(backup);
    return target.store.characterMerges;
  };
  const legacy = await restore(oldBackup);
  assert.deepEqual(legacy.request(f.drama.id, merged.request_id).result, merged);
  assert.deepEqual(legacy.request(f.drama.id, rejectInput.request_id), {found:false});
  const restored = await restore(mixedBackup);
  assert.deepEqual(restored.request(f.drama.id, merged.request_id).result, {...merged, can_undo:false});
  assert.deepEqual(restored.request(f.drama.id, undone.request_id).result, undone);
  assert.deepEqual(restored.request(f.drama.id, rejectInput.request_id), f.svc.request(f.drama.id, rejectInput.request_id));
  assert.throws(() => restored.confirm(f.drama.id, rejectInput), {
    status:409, code:'CHARACTER_MERGE_STALE', details:{request_settled:true},
  });
  for (const change of [
    (row, result) => { row.merge_id = merged.merge_id; },
    (row, result) => { result.code = 'STORYBOARD_GENERATION_LOCKED'; result.http_status = 423; },
    (row, result) => { result.http_status = 400; },
    (row, result) => { result.details = {request_settled:true}; },
  ]) {
    const corrupted = structuredClone(mixedBackup);
    const row = corrupted.tables.creative_character_merge_requests.find(row => row.id === rejectInput.request_id);
    const result = JSON.parse(row.result_json);
    change(row, result);
    row.result_json = canonical(result);
    const {format, schema_version, checksum, ...content} = corrupted;
    corrupted.checksum = digest(content);
    assert.throws(() => f.store.validateBackup(corrupted), /备份中包含无效/);
  }
  assert.equal(f.store.get(b.id).archived_at, 0);
});
