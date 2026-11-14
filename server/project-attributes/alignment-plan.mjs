import { digest, fault, idOK, nameKey } from '../project-assets/model.mjs';
import { dimensionDTO, dimensionsInput, isRecord, isRevision, isScore } from './model.mjs';

const min = 3;
const max = 8;
const retain = 'retain_legacy';
const map = 'map_existing';
const add = 'add_to_series';
const isPlainRecord = value => isRecord(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

function invalidInput(message, details) {
  return fault(message, 422, { code: 'ATTRIBUTE_ALIGNMENT_INPUT_INVALID', details });
}

function invalidChoice(message, itemId) {
  return fault(message, 422, { code: 'ATTRIBUTE_CHOICES_INVALID', details: itemId && { item_id: itemId } });
}

function describeDimensions(config, projectId) {
  let dimensions;
  try {
    const input = config?.dimensions;
    dimensions = dimensionsInput(Array.isArray(input) ? [...input] : input);
  } catch (error) {
    if (!error.status) throw error;
    throw invalidInput(error.message, projectId && { project_id: projectId });
  }
  if (dimensions.some(dimension => dimension.id === null)) {
    throw invalidInput('维度编号不能为空', projectId && { project_id: projectId });
  }
  return dimensions.map((dimension, index) => {
    const dto = dimensionDTO({ ...dimension, id: config.dimensions[index].id });
    const { name, negative_label, positive_label, tier_labels, criterion } = dto;
    const name_key = nameKey(name);
    // A custom tier's center is the label displayed for a neutral score.
    const meaning = JSON.stringify([negative_label, positive_label, tier_labels, criterion]);
    return { dto, name_key, meaning, definition: JSON.stringify([name, dto.neutral_label, meaning]) };
  });
}

function tally() {
  return { people: new Set(), archived: new Set(), scored_cells: 0, manual_clear_cells: 0 };
}

function addCell(count, record, score) {
  const id = record.id.toLowerCase();
  count.people.add(id);
  if (record.archived_at) count.archived.add(id);
  if (score.value === null) count.manual_clear_cells++;
  else count.scored_cells++;
}

function impact(count, project_count) {
  return {
    project_count, people: count.people.size, archived_people: count.archived.size,
    scored_cells: count.scored_cells, manual_clear_cells: count.manual_clear_cells,
  };
}

function episodeScores(episode, total, usedIds) {
  const scoresByKey = new Map(), seen = new Set();
  for (const record of episode.records) {
    if (!isRecord(record) || !idOK(record.id) || seen.has(record.id.toLowerCase()) || !isRevision(record.revision) ||
        record.archived_at !== null && !isRevision(record.archived_at) || !isPlainRecord(record.scores)) {
      throw invalidInput('人物评分记录无效或重复', { project_id: episode.project_id });
    }
    seen.add(record.id.toLowerCase());
    for (const [key, score] of Object.entries(record.scores)) {
      const valid = isPlainRecord(score) && (
        score.source === 'manual' && (isScore(score.value) || score.value === null) ||
        score.source === 'ai' && isScore(score.value)
      );
      if (!valid) throw invalidInput('人物评分格无效', {
        project_id: episode.project_id, asset_id: record.id, source_dimension_id: key,
      });
      usedIds.add(key.toLowerCase());
      if (!scoresByKey.has(key)) scoresByKey.set(key, tally());
      addCell(scoresByKey.get(key), record, score);
      addCell(total, record, score);
    }
  }
  return scoresByKey;
}

function candidates(sources, targets) {
  const targetClaims = new Map();
  const matches = sources.map(source => {
    const eligible = targets.filter(target => target.meaning === source.meaning);
    const exact = eligible.find(target => target.name_key === source.name_key);
    // An exact match has one automatic candidate. A renamed axis can claim any equivalent target.
    for (const target of exact ? [exact] : eligible) {
      targetClaims.set(target, (targetClaims.get(target) ?? 0) + 1);
    }
    return { exact, eligible };
  });
  for (const match of matches) {
    const possible = match.exact ? [match.exact] : match.eligible;
    match.contested = possible.some(target => targetClaims.get(target) > 1);
  }
  return matches;
}

function decisionReason(source, targets, eligible, contested) {
  if (contested) return 'target_conflict';
  if (eligible.length > 1) return 'ambiguous';
  const sameName = targets.find(target => target.name_key === source.name_key);
  if (!sameName) return 'missing_in_series';
  if (sameName.dto.negative_label === source.dto.positive_label &&
      sameName.dto.positive_label === source.dto.negative_label) return 'direction_conflict';
  return 'different_meaning';
}

function analyzeEpisode(episode, targets, total, usedIds) {
  const sources = describeDimensions(episode.config, episode.project_id);
  const { project_id, project_name, membership_revision, records } = episode;
  const scores = episodeScores(episode, total, usedIds);
  const matches = candidates(sources, targets);
  const automatic = [], decisions = [], mappings = new Map();

  function addDecision(source_dimension_id, source, reason, eligible = []) {
    const item_id = digest(['attribute-alignment-item', project_id, source_dimension_id]);
    const view = {
      item_id, source_dimension_id, source_dimension: source?.dto ?? null, reason,
      allowed_actions: [retain, ...(eligible.length ? [map] : []), ...(source ? [add] : [])],
      eligible_targets: eligible.map(target => target.dto), suggested_choice: { item_id, action: retain },
      impact: impact(scores.get(source_dimension_id) ?? tally(), 1),
    };
    decisions.push({ view, source });
  }

  for (const [index, source] of sources.entries()) {
    const id = source.dto.id;
    usedIds.add(id.toLowerCase());
    const { exact, eligible, contested } = matches[index];
    if (exact && !contested) {
      const target = exact.dto.id;
      mappings.set(id, target);
      automatic.push({ source_dimension_id: id, target_dimension_id: target,
        mode: id === target ? 'unchanged' : 'remap', impact: impact(scores.get(id) ?? tally(), 1) });
    } else {
      addDecision(id, source, decisionReason(source, targets, eligible, contested), eligible);
    }
  }
  const knownIds = new Set(sources.map(source => source.dto.id));
  for (const id of [...scores.keys()].filter(id => !knownIds.has(id)).sort()) {
    addDecision(id, null, 'unknown_score_key');
  }
  const identical = automatic.length === targets.length && automatic.every((row, index) =>
    row.mode === 'unchanged' && row.target_dimension_id === targets[index].dto.id &&
    sources[index].definition === targets[index].definition);
  const view = { project_id, project_name, membership_revision, automatic,
    comparison: decisions.length ? 'needs_review' : identical ? 'identical' : 'auto_map',
    decisions: decisions.map(decision => decision.view), target_only_dimensions: [] };
  return { view, decisions, mappings, records };
}

function readChoices(choices, projects) {
  const items = new Map(projects.flatMap(project => project.decisions.map(decision => [decision.view.item_id, decision.view])));
  if (choices !== undefined && !Array.isArray(choices)) throw invalidChoice('维度对应选项必须是数组');
  const selected = new Map();
  for (const choice of choices ?? []) {
    if (!isPlainRecord(choice) || typeof choice.item_id !== 'string') throw invalidChoice('维度对应选项格式无效');
    const { item_id, action, target_dimension_id } = choice;
    const item = items.get(item_id);
    if (!item || selected.has(item_id) || !item.allowed_actions.includes(action)) {
      throw invalidChoice('维度对应选项不存在、重复或不可用', item_id);
    }
    const fields = action === map ? ['item_id', 'action', 'target_dimension_id'] : ['item_id', 'action'];
    if (Object.keys(choice).length !== fields.length || !fields.every(field => Object.hasOwn(choice, field))) {
      throw invalidChoice('维度对应选项含有无效字段', item_id);
    }
    const target = action === map && idOK(target_dimension_id) &&
      item.eligible_targets.find(dimension => dimension.id.toLowerCase() === target_dimension_id.toLowerCase());
    if (action === map && !target) throw invalidChoice('目标维度的评分含义与来源不一致或已不可用', item_id);
    selected.set(item_id, { item_id, action, ...(target && { target_dimension_id: target.id }) });
  }
  return new Map([...items].map(([id, item]) => [id, selected.get(id) ?? item.suggested_choice]));
}

function destinationRoster(peopleCount, total, projectCount) {
  // A numeric count can only infer archival status from the supplied score records.
  const count = typeof peopleCount === 'number'
    ? { people: peopleCount, archived_people: total.archived.size }
    : peopleCount;
  const { people, archived_people, project_count = projectCount } = count ?? {};
  if (!isRevision(people) || !isRevision(archived_people) || archived_people > people ||
      !isRevision(project_count) || project_count < projectCount ||
      archived_people < total.archived.size || people - archived_people < total.people.size - total.archived.size) {
    throw invalidInput('新增维度需要目标剧的人物及归档人数');
  }
  return { project_count, people, archived_people };
}

function addedId(context, itemId, key, usedIds) {
  for (let attempt = 0; ; attempt++) {
    const hash = digest(['attribute-alignment-dimension', context, itemId, key, attempt]);
    // UUIDv8 reserves these bits for the version and RFC variant.
    const variant = (8 | (Number.parseInt(hash[16], 16) & 3)).toString(16);
    const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    if (!usedIds.has(id)) {
      usedIds.add(id);
      return id;
    }
  }
}

function addBlockers(blockers, code, entries) {
  for (const { project, decision } of entries) {
    blockers.push({ code, project_id: project.view.project_id, item_id: decision.view.item_id });
  }
}

function applyChoices(projects, choices, blockers) {
  const additions = new Map();
  for (const project of projects) {
    const claims = new Map();
    for (const decision of project.decisions) {
      const { item_id, source_dimension_id } = decision.view;
      const choice = choices.get(item_id);
      const entry = { project, decision };
      if (choice.action === add) {
        const key = decision.source.definition;
        if (!additions.has(key)) additions.set(key, []);
        additions.get(key).push(entry);
      } else {
        const target = choice.target_dimension_id ?? null;
        project.mappings.set(source_dimension_id, target);
        if (target !== null) {
          if (!claims.has(target)) claims.set(target, []);
          claims.get(target).push(entry);
        }
      }
    }
    for (const entries of claims.values()) {
      if (entries.length > 1) addBlockers(blockers, 'ATTRIBUTE_TARGET_CONFLICT', entries);
    }
  }
  return additions;
}

function proposeAdditions(additions, targets, context, usedIds, roster, blockers) {
  const nameCounts = new Map(targets.map(target => [target.name_key, 1]));
  for (const [{ decision }] of additions.values()) {
    const name = decision.source.name_key;
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  const overLimit = targets.length + additions.size > max;
  return [...additions].map(([key, entries]) => {
    const item_ids = entries.map(({ decision }) => decision.view.item_id).sort();
    const representative = entries.find(({ decision }) => decision.view.item_id === item_ids[0]).decision.source;
    const dimension = { ...representative.dto, id: addedId(context, item_ids[0], key, usedIds) };
    if (nameCounts.get(representative.name_key) > 1) addBlockers(blockers, 'ATTRIBUTE_DIMENSION_NAME_CONFLICT', entries);
    if (overLimit) addBlockers(blockers, 'ATTRIBUTE_DIMENSION_LIMIT', entries);
    const addedImpact = { ...roster, scored_cells: 0, manual_clear_cells: 0 };
    for (const { project, decision } of entries) {
      project.mappings.set(decision.view.source_dimension_id, dimension.id);
      addedImpact.scored_cells += decision.view.impact.scored_cells;
      addedImpact.manual_clear_cells += decision.view.impact.manual_clear_cells;
    }
    return { item_ids, dimension, impact: addedImpact };
  });
}

export function planAttributeAlignment(input) {
  if (!isPlainRecord(input)) throw invalidInput('属性维度预览输入无效');
  const { seriesId, alignmentRevision, config, episodes, choices, peopleCount, ...unexpected } = input;
  if (seriesId !== null && !idOK(seriesId) || !isRevision(alignmentRevision) || !Array.isArray(episodes)) {
    throw invalidInput('剧编号、对齐修订号或集列表无效');
  }
  if (Object.keys(unexpected).length) throw invalidInput('属性维度预览含有未知字段');
  const targets = describeDimensions(config);
  const usedIds = new Set(targets.map(target => target.dto.id.toLowerCase()));
  const projectIds = new Set(), total = tally();
  const projects = [];
  for (const episode of episodes) {
    if (!isRecord(episode) || !idOK(episode.project_id) || projectIds.has(episode.project_id.toLowerCase()) ||
        typeof episode.project_name !== 'string' || !isRevision(episode.membership_revision) || !Array.isArray(episode.records)) {
      throw invalidInput('集的编号、归组修订号或评分列表无效或重复');
    }
    projectIds.add(episode.project_id.toLowerCase());
    projects.push(analyzeEpisode(episode, targets, total, usedIds));
  }
  const normalizedChoices = readChoices(choices, projects);
  const blockers = [];
  const additions = applyChoices(projects, normalizedChoices, blockers);
  const destination = additions.size || peopleCount !== undefined
    ? destinationRoster(peopleCount, total, projects.length) : null;
  const roster = additions.size ? destination : null;
  const owner = seriesId?.toLowerCase() ?? [config.project_id ?? null, [...projectIds].sort()];
  const context = [owner, alignmentRevision, config.revision ?? null];
  const added = proposeAdditions(additions, targets, context, usedIds, roster, blockers);
  const finalDimensions = [...targets.map(target => target.dto), ...added.map(entry => entry.dimension)];
  for (const project of projects) {
    const occupied = new Set(project.mappings.values());
    project.view.target_only_dimensions = finalDimensions.filter(dimension => !occupied.has(dimension.id));
  }
  const ready = blockers.length === 0;
  const view = {
    series_id: seriesId, alignment_revision: alignmentRevision, ready,
    episodes: projects.map(project => project.view), choices: [...normalizedChoices.values()],
    series_changes: { added, dimension_count_before: targets.length, dimension_count_after: finalDimensions.length, min, max },
    total_impact: { ...impact(total, projects.length), ...roster }, blockers,
  };
  const projectPlans = ready ? projects.map(({ view, mappings, records }) => ({
    project_id: view.project_id, records,
    mappings: [...mappings].map(([source_dimension_id, target_dimension_id]) => ({ source_dimension_id, target_dimension_id })),
  })) : [];
  return { view, projectPlans, addedDimensions: ready ? added.map(entry => entry.dimension) : [] };
}
