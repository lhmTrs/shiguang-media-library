import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AGENT_GUIDE_VERSION, projectAgentGuide} from '../server/project-agent-guide.mjs';
import {StoryboardDatabase} from '../server/storyboard/database.mjs';
import {creativeFixture} from './helpers/creative-fixture.mjs';
import {syntheticSource} from './helpers/storyboard-fixture.mjs';

const jsonExamples = text => [...text.matchAll(/^```json\n([\s\S]*?)\n```$/gm)].map(match => JSON.parse(match[1]));
const guideFor = project => projectAgentGuide({project, origin: 'http://127.0.0.1:4518', instanceId: 'synthetic-library'});

test('guide binding stays machine/project-specific without exposing unrelated project metadata', () => {
  const project = {id: randomUUID(), name: '合成项目', note: 'PRIVATE_NOTE', path: '/PRIVATE/PATH', token: 'PRIVATE_TOKEN'};
  const text = guideFor(project), examples = jsonExamples(text);
  assert.ok(text.includes(`说明版本：${AGENT_GUIDE_VERSION}`));
  assert.deepEqual(examples[0], {projectName: project.name, projectId: project.id,
    instanceId: 'synthetic-library', origin: 'http://127.0.0.1:4518'});
  assert.ok(text.includes(`http://127.0.0.1:4518/api/projects/${project.id}/agent-guide`));
  for (const privateValue of [project.note, project.path, project.token]) assert.ok(!text.includes(privateValue));
  assert.ok(!text.includes('/api/media/search?'));
});

test('published save, clear and restore JSON examples work with revision and concurrent-pending protection', async t => {
  const f = await creativeFixture();
  t.after(f.close);
  const board = new StoryboardDatabase(f.lib, f.store).init();
  const first = board.initialize(f.a.id, {source: syntheticSource(), expected_revision: null, request_id: randomUUID()});
  const examples = jsonExamples(guideFor(f.a));
  const saveExample = examples.find(value => value.project && value.change);
  const clearExample = examples.find(value => value.through_version !== undefined);
  const restoreExample = examples.find(value => value.request_id?.includes('恢复'));
  assert.ok(saveExample && clearExample && restoreExample);

  const save = structuredClone(saveExample);
  Object.assign(save, {project: structuredClone(first.project), expected_revision: first.revision, request_id: randomUUID()});
  save.change.reason_text = '第一镜补一个点头动作';
  save.project.scenes[0].shots[0].action += ' 他点头。';
  const saved = board.save(f.a.id, save);
  const checksum = board.backup().checksum;
  const versions = board.history.versions(f.a.id, {offset: 0, limit: 20});
  assert.equal(versions.total, 2);
  assert.equal(board.history.version(f.a.id, first.revision).project.scenes[0].shots[0].action,
    first.project.scenes[0].shots[0].action);
  assert.ok(board.history.diff(f.a.id, first.revision).changes.some(value => value.field === 'action'));
  const viewed = board.history.pending(f.a.id);
  assert.equal(viewed.current_revision, saved.revision);
  assert.equal(viewed.pending_count, 1);
  assert.equal(board.backup().checksum, checksum, 'history reads must not acknowledge or rewrite content');
  assert.deepEqual(board.request(f.a.id, save.request_id), {completed: false},
    '/requests is the initialization receipt, not the ordinary-save receipt');

  const concurrent = structuredClone(save);
  Object.assign(concurrent, {project: structuredClone(saved.project), expected_revision: saved.revision, request_id: randomUUID()});
  concurrent.project.scenes[0].shots[0].action += ' 他抬头。';
  const newer = board.save(f.a.id, concurrent);
  const clear = structuredClone(clearExample);
  clear.through_version = viewed.current_revision;
  clear.shot_ids = [saved.project.scenes[0].shots[0].id];
  board.history.clear(f.a.id, clear);
  assert.deepEqual(board.history.pending(f.a.id).items.flatMap(value => value.versions), [newer.revision]);
  assert.throws(() => board.save(f.a.id, {...save, request_id: randomUUID()}), error => error.status === 409);

  const restore = {...restoreExample, expected_revision: newer.revision, request_id: randomUUID()};
  const restored = board.restoreVersion(f.a.id, first.revision, restore);
  assert.equal(restored.revision, newer.revision + 1);
  assert.equal(restored.project.scenes[0].shots[0].action, first.project.scenes[0].shots[0].action);
  assert.equal(board.restoreVersion(f.a.id, first.revision, restore).repeated, true);
  assert.equal(board.history.pending(f.a.id).pending_count, 1, 'restore does not clear the later agent change');
});
