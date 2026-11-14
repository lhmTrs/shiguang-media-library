import { canonical, digest, fault, idOK, nameKey, text } from './model.mjs';
import { isRecord, isRevision, isScore, textField } from '../project-attributes/model.mjs';

export const mergeError = (code, message, status = 409, details) => fault(message, status, { code, details });
export const badChoice = () => mergeError('CHARACTER_MERGE_CHOICE_INVALID', '造型选项无效，请重新预览', 422);
export const activeChild = row => row.archived_at === null;

export function scoreValue(value, allowOrigin = false) {
  if (!isRecord(value)) return false;
  const fields = Object.keys(value).sort().join(',');
  if (fields !== 'reason,source,updated_at,value' &&
      (!allowOrigin || fields !== 'merge_id,reason,source,source_asset_id,updated_at,value' ||
       !idOK(value.merge_id) || !idOK(value.source_asset_id))) return false;
  if (!isRevision(value.updated_at)) return false;
  if (value.source === 'manual') return value.reason === null && (value.value === null || isScore(value.value));
  if (value.source !== 'ai' || !isScore(value.value)) return false;
  try { return textField(value.reason, 200, '评分依据') === value.reason; }
  catch { return false; }
}

export function lookPlan(group, primary, choices, references) {
  if (choices !== undefined && (!isRecord(choices) || Object.keys(choices).length !== 1 ||
      !Array.isArray(choices.look_choices) || choices.look_choices.length > 10000)) throw badChoice();
  const supplied = new Map();
  for (const choice of choices?.look_choices ?? []) {
    if (!isRecord(choice) || typeof choice.conflict_id !== 'string' || supplied.has(choice.conflict_id)) throw badChoice();
    supplied.set(choice.conflict_id, choice);
  }
  const taken = new Map(), items = [], conflicts = [], normalized = [];
  const active = person => person.looks.filter(activeChild);
  const keep = (person, look, name, action, result = look.id) => {
    const image_count = person.images.filter(image => activeChild(image) && image.look_id === look.id).length;
    items.push({ source_asset_id: person.id, source_look_id: look.id, result_look_id: result, result_name: name, action, image_count });
    if (action !== 'merge_into') {
      const key = nameKey(name);
      taken.set(key, [...(taken.get(key) ?? []), { id: look.id, name }]);
    }
  };
  for (const look of active(primary)) keep(primary, look, look.name, 'keep');
  for (const person of group.filter(member => member.id !== primary.id)) {
    for (const look of active(person)) {
      const targets = taken.get(nameKey(look.name));
      if (!targets) {
        keep(person, look, look.name, 'keep');
        continue;
      }
      const conflict_id = digest(['character-merge-look', person.id, look.id]);
      const episode = person.episode;
      const label = episode?.season_no ? '第' + episode.season_no + '季第' + episode.episode_no + '集' : '第' + episode?.episode_no + '集';
      const base = look.name.slice(0, 96) + ' · ' + label;
      let suggested_name = base;
      for (let index = 2; taken.has(nameKey(suggested_name)); index++) suggested_name = base + ' ' + index;
      const default_choice = { conflict_id, action: 'keep_both', rename_to: suggested_name };
      const choice = supplied.get(conflict_id) ?? default_choice;
      const allowed_targets = targets.map(target => target.id);
      const affected_shots = references.filter(ref => ref.looks.includes(look.id)).length;
      conflicts.push({ conflict_id, source_look_id: look.id, allowed_targets, suggested_name, default_choice, affected_shots });
      supplied.delete(conflict_id);
      if (choice.action === 'keep_both' && Object.keys(choice).length === 3 && typeof choice.rename_to === 'string') {
        let name;
        try { name = text(choice.rename_to, '造型名称', 120, true); } catch { throw badChoice(); }
        if (taken.has(nameKey(name))) throw badChoice();
        normalized.push({ ...choice, rename_to: name });
        keep(person, look, name, 'rename');
      } else if (choice.action === 'merge_into' && Object.keys(choice).length === 3 && allowed_targets.includes(choice.target_look_id)) {
        normalized.push(choice);
        keep(person, look, targets.find(target => target.id === choice.target_look_id).name, 'merge_into', choice.target_look_id);
      } else throw badChoice();
    }
  }
  if (supplied.size) throw badChoice();
  return { items, conflicts, choices: { look_choices: normalized } };
}

const decode = raw => { try { return JSON.parse(raw); } catch { return undefined; } };

export function planScores({ people, primary, rows, dimensions, overrides }) {
  const blockers = [];
  const records = new Map(rows.map(row => [row.id, row]));
  const scores = new Map();
  const allowed = new Set(dimensions.map(dimension => dimension.id));
  for (const person of people) {
    const row = records.get(person.id);
    const values = row ? decode(row.data_json) : {};
    const wrongOwner = row && (row.series_id ?? row.project_id) !== person.owner_id;
    if (wrongOwner || !isRecord(values) || Object.entries(values).some(([id, value]) => !allowed.has(id) || !scoreValue(value))) {
      blockers.push({ code: 'CHARACTER_MERGE_INVALID_SCORES', asset_id: person.id });
      scores.set(person.id, []);
    } else scores.set(person.id, Object.entries(values).sort().map(([dimension_id, value]) => ({ dimension_id, ...value })));
  }
  const existing = new Map();
  for (const row of overrides.filter(row => row.field_key.startsWith('attribute_score:'))) {
    const dimensionId = row.field_key.split(':')[1];
    const value = decode(row.value_json);
    if (!allowed.has(dimensionId) || row.scope_type !== 'episode' || !scoreValue(value, true))
      blockers.push({ code: 'CHARACTER_MERGE_INVALID_SCORES', project_id: row.scope_id, dimension_id: dimensionId });
    existing.set(row.scope_id + '/' + dimensionId, row);
  }
  const episode_overrides = [], override_conflicts = [];
  for (const person of people.filter(person => person.id !== primary.id)) {
    const entries = scores.get(person.id);
    for (const { dimension_id } of entries) {
      const key = person.project_id + '/' + dimension_id;
      if (existing.delete(key)) override_conflicts.push({
        project_id: person.project_id, dimension_id, kept_source_asset_id: person.id, previous_override_archived: true,
      });
    }
    if (entries.length) episode_overrides.push({
      project_id: person.project_id, source_asset_id: person.id, entries,
      manual_count: entries.filter(e => e.source === 'manual' && e.value !== null).length,
      ai_count: entries.filter(e => e.source === 'ai').length,
      clear_count: entries.filter(e => e.value === null).length,
    });
  }
  return {
    view: {
      series_base: { source_asset_id: primary.id, entries: scores.get(primary.id) },
      episode_overrides, override_conflicts, existing_overrides_preserved: existing.size,
    },
    blockers,
  };
}

export function changedFields(current, expected) {
  if (!current || !expected) return current === expected ? [] : ['identity'];
  return Object.keys(expected).filter(key => !['revision', 'created_at', 'updated_at'].includes(key) &&
    canonical(current[key]) !== canonical(expected[key]));
}
