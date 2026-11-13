import assert from 'node:assert/strict';
import test from 'node:test';
import { planAttributeAlignment as plan } from '../server/project-attributes/alignment-plan.mjs';
import { DEFAULT_DIMENSIONS, dimensionDTO } from '../server/project-attributes/model.mjs';

const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const [first, second, third, fourth, fifth, sixth] = DEFAULT_DIMENSIONS;
const base = [first, second, third];
const manual = value => ({ value, source: 'manual', reason: null, updated_at: 123 });
const ai = value => ({ value, source: 'ai', reason: '剧本依据', updated_at: 456 });
const person = (n, scores, archived_at = 0) => ({ id: id(n), revision: 1, archived_at, scores });
const episode = (n, dimensions = base, records = []) => ({
  project_id: id(n), project_name: `第 ${n} 集`, membership_revision: n, config: { dimensions }, records,
});
const input = (episodes, dimensions = base) => ({
  seriesId: id(100), alignmentRevision: 3, config: { revision: 4, dimensions }, episodes,
});
const decisionFor = (view, sourceId, episodeIndex = 0) =>
  view.episodes[episodeIndex].decisions.find(item => item.source_dimension_id === sourceId);
const choice = (item, action, target) => ({ item_id: item.item_id, action, ...(target && { target_dimension_id: target.id }) });
const row = (source, target) => ({ source_dimension_id: source.id, target_dimension_id: target?.id ?? null });
const impact = (project_count, people, archived_people, scored_cells, manual_clear_cells) =>
  ({ project_count, people, archived_people, scored_cells, manual_clear_cells });

test('identical configurations include identity mappings and preserve scored records', () => {
  const records = [person(10, { [first.id]: manual(0), [third.id]: manual(null) }),
    person(11, { [first.id]: ai(-100) }, 100), person(12, {})];
  const snapshot = input([episode(1, base.map(dimensionDTO), records), episode(2)]);
  const before = structuredClone(snapshot);
  const result = plan(snapshot);
  assert.deepEqual(snapshot, before);
  assert.deepEqual(Object.keys(result).sort(), ['addedDimensions', 'projectPlans', 'view']);
  assert.equal(Object.hasOwn(result.view, 'preview_token'), false);
  assert.equal(result.view.series_id, snapshot.seriesId);
  assert.equal(result.view.alignment_revision, snapshot.alignmentRevision);
  assert.equal(result.view.ready, true);
  assert.deepEqual(result.view.choices, []);
  assert.deepEqual(result.addedDimensions, []);
  assert.deepEqual(result.view.episodes.map(project => project.comparison), ['identical', 'identical']);
  assert.deepEqual(result.view.episodes[0].automatic, [
    { ...row(first, first), mode: 'unchanged', impact: impact(1, 2, 1, 2, 0) },
    { ...row(second, second), mode: 'unchanged', impact: impact(1, 0, 0, 0, 0) },
    { ...row(third, third), mode: 'unchanged', impact: impact(1, 1, 0, 0, 1) },
  ]);
  assert.deepEqual(result.projectPlans[0], { project_id: id(1), mappings: base.map(d => row(d, d)), records });
  assert.deepEqual(result.view.episodes[0].target_only_dimensions, []);
  assert.deepEqual(result.view.total_impact, impact(2, 2, 1, 2, 1));
});

test('automatic mappings match normalized names and effective tiers across IDs and order', () => {
  const renamedTarget = { ...first, name: 'Café' };
  const source = { ...first, id: id(20), name: ' CAFE\u0301 ', tier_labels: dimensionDTO(first).tier_labels };
  const result = plan(input([episode(1, [third, second, source])], [renamedTarget, second, third, fourth]));
  assert.equal(result.view.episodes[0].comparison, 'auto_map');
  assert.deepEqual(result.view.episodes[0].automatic.map(({ mode }) => mode), ['unchanged', 'unchanged', 'remap']);
  assert.deepEqual(result.projectPlans[0].mappings, [row(third, third), row(second, second), row(source, renamedTarget)]);
  assert.deepEqual(result.view.episodes[0].target_only_dimensions, [dimensionDTO(fourth)]);
  assert.deepEqual(result.view.choices, []);
});

test('a shared ID cannot bypass the direction, criterion, middle or five-tier checks', () => {
  const changes = [
    [{ ...first, negative_label: first.positive_label, positive_label: first.negative_label }, 'direction_conflict'],
    [{ ...first, criterion: '衡量每场具体行动' }, 'different_meaning'],
    [{ ...first, neutral_label: '明确中立' }, 'different_meaning'],
    [{ ...first, tier_labels: ['极邪恶', '偏邪恶', '善恶未明', '偏善良', '绝对善良'] }, 'different_meaning'],
    [{ ...first, tier_labels: ['极邪恶', '偏邪恶', '明确中立', '偏善良', '极善良'] }, 'different_meaning'],
  ];
  for (const [source, reason] of changes) {
    const result = plan(input([episode(1, [source, second, third], [person(10, { [first.id]: manual(0) })])]));
    const decision = decisionFor(result.view, first.id);
    assert.equal(decision.reason, reason);
    assert.deepEqual(decision.allowed_actions, ['retain_legacy', 'add_to_series']);
    assert.deepEqual(decision.eligible_targets, []);
    assert.deepEqual(result.view.choices, [choice(decision, 'retain_legacy')]);
    assert.equal(result.view.ready, true);
    assert.ok(result.projectPlans[0].mappings.some(mapping => mapping.source_dimension_id === first.id && mapping.target_dimension_id === null));
  }
});

test('an explicitly configured middle tier takes precedence and renamed axes require a choice', () => {
  const target = { ...first, criterion: '以行动为依据', tier_labels: dimensionDTO(first).tier_labels };
  const source = { ...target, id: id(20), name: '道德立场', neutral_label: '旧版占位文字' };
  const snapshot = input([episode(1, [source, second, third], [person(10, { [source.id]: ai(0) })])], [target, second, third]);
  const firstView = plan(snapshot).view;
  const item = decisionFor(firstView, source.id);
  assert.equal(item.reason, 'missing_in_series');
  assert.deepEqual(item.eligible_targets, [dimensionDTO(target)]);
  assert.deepEqual(firstView.episodes[0].target_only_dimensions, [dimensionDTO(target)]);
  const result = plan({ ...snapshot, choices: [choice(item, 'map_existing', target)] });
  assert.deepEqual(result.view.choices, [choice(item, 'map_existing', target)]);
  assert.ok(result.projectPlans[0].mappings.some(mapping => mapping.target_dimension_id === target.id));
  assert.deepEqual(result.view.episodes[0].target_only_dimensions, []);
  const sameName = { ...source, name: target.name };
  assert.equal(plan(input([episode(1, [sameName, second, third])], [target, second, third])).view.episodes[0].automatic[0].mode, 'remap');
});

test('multiple equal-scoring targets make a renamed axis ambiguous', () => {
  const alternate = { ...first, id: id(21), name: '道德倾向' };
  const source = { ...first, id: id(22), name: '道德立场' };
  const snapshot = input([episode(1, [source, second, third])], [first, alternate, second, third]);
  const item = decisionFor(plan(snapshot).view, source.id);
  assert.equal(item.reason, 'ambiguous');
  assert.deepEqual(item.eligible_targets.map(d => d.id), [first.id, alternate.id]);
  const result = plan({ ...snapshot, choices: [choice(item, 'map_existing', alternate)] });
  assert.ok(result.projectPlans[0].mappings.some(mapping => mapping.target_dimension_id === alternate.id));
  const exact = plan(input([episode(1, [first, alternate, second])], [first, alternate, second]));
  assert.equal(exact.view.episodes[0].comparison, 'identical');
});

test('automatic and manual competitors become decisions and duplicate target choices block both items', () => {
  const alias = { ...first, id: id(21), name: '道德立场' };
  const records = [person(10, { [first.id]: manual(12), [alias.id]: manual(null) })];
  const snapshot = input([episode(1, [first, alias, second, third], records)]);
  const preview = plan(snapshot).view;
  const left = decisionFor(preview, first.id), right = decisionFor(preview, alias.id);
  assert.deepEqual([left.reason, right.reason], ['target_conflict', 'target_conflict']);
  assert.deepEqual(preview.episodes[0].automatic.map(entry => entry.source_dimension_id), [second.id, third.id]);
  const blocked = plan({ ...snapshot, choices: [choice(right, 'map_existing', first), choice(left, 'map_existing', first)] });
  assert.equal(blocked.view.ready, false);
  assert.deepEqual(blocked.projectPlans, []);
  assert.deepEqual(blocked.view.blockers, [left, right].map(item => ({
    code: 'ATTRIBUTE_TARGET_CONFLICT', project_id: id(1), item_id: item.item_id,
  })));
  const resolved = plan({ ...snapshot, choices: [choice(right, 'map_existing', first)] });
  assert.equal(resolved.view.ready, true);
  assert.deepEqual(resolved.view.choices, [choice(left, 'retain_legacy'), choice(right, 'map_existing', first)]);
  assert.deepEqual(resolved.projectPlans[0].mappings.filter(mapping => mapping.target_dimension_id === first.id), [row(alias, first)]);
});

test('unknown score keys can only be retained in history even when the target has that ID', () => {
  const records = [person(10, { [fourth.id]: manual(0), ['__proto__']: manual(null) }, 12)];
  const snapshot = input([episode(1, base, records)], [...base, fourth]);
  const result = plan(snapshot);
  const unknown = decisionFor(result.view, fourth.id), opaque = decisionFor(result.view, '__proto__');
  for (const item of [unknown, opaque]) {
    assert.equal(item.reason, 'unknown_score_key');
    assert.equal(item.source_dimension, null);
    assert.deepEqual(item.allowed_actions, ['retain_legacy']);
    assert.deepEqual(item.eligible_targets, []);
  }
  assert.deepEqual(result.projectPlans[0].records, records);
  assert.deepEqual(result.projectPlans[0].mappings.slice(-2), [row(fourth, null), row({ id: '__proto__' }, null)]);
  assert.deepEqual(unknown.impact, impact(1, 1, 1, 1, 0));
  assert.deepEqual(opaque.impact, impact(1, 1, 1, 0, 1));
  assert.deepEqual(result.view.total_impact, impact(1, 1, 1, 1, 1));
  assert.throws(() => plan({ ...snapshot, choices: [choice(unknown, 'map_existing', fourth)] }),
    { status: 422, code: 'ATTRIBUTE_CHOICES_INVALID', details: { item_id: unknown.item_id } });
});

test('cross-episode identical additions coalesce and the destination roster is counted once', () => {
  const customA = { ...fourth, id: id(40) }, customB = { ...dimensionDTO(fourth), id: id(41) };
  const extra = { ...fifth, id: id(42) };
  const episodes = [episode(1, [...base, customA, extra], [person(10, { [customA.id]: manual(0), [extra.id]: ai(12) })]),
    episode(2, [...base, customB], [person(11, { [customB.id]: manual(null) }, 101)])];
  const snapshot = { ...input(episodes), seriesId: null, peopleCount: { people: 9, archived_people: 2, project_count: 3 } };
  const preview = plan(snapshot).view;
  const picks = [decisionFor(preview, customB.id, 1), decisionFor(preview, customA.id), decisionFor(preview, extra.id)]
    .map(item => choice(item, 'add_to_series'));
  const result = plan({ ...snapshot, choices: picks });
  assert.equal(result.view.ready, true);
  assert.deepEqual(result.view.choices, [picks[1], picks[2], picks[0]]);
  const { added, dimension_count_before, dimension_count_after, min, max } = result.view.series_changes;
  assert.deepEqual([dimension_count_before, dimension_count_after, min, max], [3, 5, 3, 8]);
  assert.deepEqual(result.addedDimensions, added.map(entry => entry.dimension));
  assert.deepEqual(added[0].item_ids, [picks[0].item_id, picks[1].item_id].sort());
  assert.deepEqual(added[0].impact, impact(3, 9, 2, 1, 1));
  assert.deepEqual(added[1].impact, impact(3, 9, 2, 1, 0));
  assert.deepEqual(result.view.total_impact, impact(3, 9, 2, 2, 1));
  assert.match(added[0].dimension.id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(added[0].dimension.id, customA.id);
  assert.notEqual(added[0].dimension.id, added[1].dimension.id);
  assert.ok(result.projectPlans[0].mappings.some(mapping => mapping.target_dimension_id === added[0].dimension.id));
  assert.ok(result.projectPlans[1].mappings.some(mapping => mapping.target_dimension_id === added[0].dimension.id));
  assert.deepEqual(result.view.episodes[1].target_only_dimensions, [added[1].dimension]);
  assert.deepEqual(plan({ ...snapshot, choices: picks.toReversed() }), result);
  const reversed = plan({ ...snapshot, episodes: episodes.toReversed(), choices: picks });
  assert.equal(reversed.addedDimensions.find(d => d.name === fourth.name).id, added[0].dimension.id);
});

test('a deterministic ID collision with a target axis retries in the same target context', () => {
  const snapshot = { ...input([episode(1, [...base, fourth])]), peopleCount: 0 };
  const choices = [choice(decisionFor(plan(snapshot).view, fourth.id), 'add_to_series')];
  const originalId = plan({ ...snapshot, choices }).addedDimensions[0].id;
  const collision = { ...snapshot, choices, config: { ...snapshot.config, dimensions: [...base, { ...fifth, id: originalId }] } };
  const result = plan(collision);
  assert.equal(result.view.ready, true);
  assert.notEqual(result.addedDimensions[0].id, originalId);
  assert.deepEqual(plan(collision), result);
  assert.notEqual(plan({ ...snapshot, seriesId: id(101), choices }).addedDimensions[0].id, originalId);
});

test('normalized duplicate names block additions and report each affected item', () => {
  const sourceA = { ...fourth, id: id(40), name: 'Rôle' };
  const sourceB = { ...fourth, id: id(41), name: ' RO\u0302LE ', criterion: '其他标准' };
  const snapshot = { ...input([episode(1, [...base, sourceA]), episode(2, [...base, sourceB])]),
    peopleCount: { people: 0, archived_people: 0 } };
  const firstView = plan(snapshot).view;
  const picks = [decisionFor(firstView, sourceA.id), decisionFor(firstView, sourceB.id, 1)].map(item => choice(item, 'add_to_series'));
  const result = plan({ ...snapshot, choices: picks });
  assert.equal(result.view.ready, false);
  assert.equal(result.view.series_changes.dimension_count_after, 5);
  assert.deepEqual(result.view.blockers, picks.map((pick, index) => ({
    code: 'ATTRIBUTE_DIMENSION_NAME_CONFLICT', project_id: id(index + 1), item_id: pick.item_id,
  })));
  assert.deepEqual(result.addedDimensions, []);
  const existing = { ...input([episode(1, [...base, sourceB])], [...base, sourceA]), peopleCount: 0 };
  const pick = choice(decisionFor(plan(existing).view, sourceB.id), 'add_to_series');
  assert.deepEqual(plan({ ...existing, choices: [pick] }).view.blockers,
    [{ code: 'ATTRIBUTE_DIMENSION_NAME_CONFLICT', project_id: id(1), item_id: pick.item_id }]);
});

test('the dimension limit is checked after coalescing and reports the over-limit proposals', () => {
  const targets = [...DEFAULT_DIMENSIONS, { ...fourth, id: id(40), name: '第七轴' }];
  const extraA = { ...fifth, id: id(41), name: '第八轴', criterion: '第八轴的评分依据' };
  const extraB = { ...sixth, id: id(42), name: '第九轴', criterion: '第九轴的评分依据' };
  const snapshot = { ...input([episode(1, [...base, extraA, extraB]), episode(2, [...base, extraA])], targets), peopleCount: 0 };
  const preview = plan(snapshot).view;
  const [a, b, otherA] = [decisionFor(preview, extraA.id), decisionFor(preview, extraB.id), decisionFor(preview, extraA.id, 1)]
    .map(item => choice(item, 'add_to_series'));
  const fits = plan({ ...snapshot, choices: [a, otherA] });
  assert.equal(fits.view.ready, true);
  assert.equal(fits.view.series_changes.dimension_count_after, 8);
  const exceeds = plan({ ...snapshot, choices: [a, b, otherA] });
  assert.equal(exceeds.view.ready, false);
  assert.equal(exceeds.view.series_changes.dimension_count_after, 9);
  assert.deepEqual(new Set(exceeds.view.blockers.map(blocker => blocker.item_id)), new Set([a.item_id, b.item_id, otherA.item_id]));
  assert.ok(exceeds.view.blockers.every(blocker => blocker.code === 'ATTRIBUTE_DIMENSION_LIMIT'));
});

test('malformed, unknown, duplicate and extraneous choices are 422 application faults', () => {
  const snapshot = input([episode(1, [...base, fourth])]);
  const item = decisionFor(plan(snapshot).view, fourth.id);
  const keep = choice(item, 'retain_legacy');
  const invalid = [null, {}, new Array(1), [{ ...keep, item_id: 'stale' }], [keep, keep],
    [{ ...keep, action: 'reverse_scores' }], [choice(item, 'map_existing', first)],
    [{ ...keep, target_dimension_id: null }], [{ ...keep, extra: true }]];
  for (const choices of invalid) {
    assert.throws(() => plan({ ...snapshot, choices }), { status: 422, code: 'ATTRIBUTE_CHOICES_INVALID' });
  }
  const alias = { ...first, id: id(51), name: '道德立场' };
  const mapSnapshot = input([episode(1, [alias, second, third])]);
  const mapItem = decisionFor(plan(mapSnapshot).view, alias.id);
  for (const invalidMap of [choice(mapItem, 'map_existing'), choice(mapItem, 'map_existing', third)]) {
    assert.throws(() => plan({ ...mapSnapshot, choices: [invalidMap] }),
      { status: 422, code: 'ATTRIBUTE_CHOICES_INVALID', details: { item_id: mapItem.item_id } });
  }
});

test('invalid snapshot shape, repeated IDs and malformed score cells produce scoped 422 faults', () => {
  const duplicate = episode(1);
  const malformed = [null, { ...input([]), unknown: true }, input([duplicate, duplicate]),
    input([episode(1, [first, second, first])]), input([], [first, second]), input([], new Array(3)),
    input([episode(1, base, [person(10, {}), person(10, {})])]),
    input([episode(1, base, [person(10, new Map([[first.id, manual(0)]]))])]),
    input([episode(1, base, [person(10, { [first.id]: { ...ai(0), value: null } })])]),
    input([episode(1, base, [person(10, { [first.id]: manual(101) })])])];
  for (const snapshot of malformed) {
    assert.throws(() => plan(snapshot), { status: 422, code: 'ATTRIBUTE_ALIGNMENT_INPUT_INVALID' });
  }
  const snapshot = input([episode(1, [...base, fourth], [person(10, { [fourth.id]: ai(0) }, 500)])]);
  const choices = [choice(decisionFor(plan(snapshot).view, fourth.id), 'add_to_series')];
  assert.throws(() => plan({ ...snapshot, choices, peopleCount: { people: 1, archived_people: 0 } }),
    { status: 422, code: 'ATTRIBUTE_ALIGNMENT_INPUT_INVALID' });
});
