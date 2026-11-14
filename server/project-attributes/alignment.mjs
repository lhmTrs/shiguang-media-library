import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { canonical, fault, idOK } from '../project-assets/model.mjs';
import { DEFAULT_DIMENSIONS, isRevision, isRecord } from './model.mjs';
import { planAttributeAlignment } from './alignment-plan.mjs';

const stale = () => fault('维度、评分或归组已变化，请重新预览', 409, { code: 'ATTRIBUTE_ALIGNMENT_STALE' });
const invalid = () => fault('维度对应选项无效', 422, { code: 'ATTRIBUTE_CHOICES_INVALID' });
const required = seriesId => fault('请先统一目标剧的人物属性维度', 409, {
  code: 'ATTRIBUTE_ALIGNMENT_REQUIRED', details: { series_id: seriesId },
});
const defaultConfig = { revision: 0, source: 'default', updated_at: null, dimensions: DEFAULT_DIMENSIONS };
const zeroImpact = { project_count: 0, people: 0, archived_people: 0, scored_cells: 0, manual_clear_cells: 0 };

export class AttributeAlignment {
  #key = randomBytes(32);

  constructor(attributes) { this.attributes = attributes; }
  get assets() { return this.attributes.assets; }
  get db() { return this.attributes.db; }
  get directory() { return this.assets.lib.projectSeries; }

  read(read) {
    if (this.db.kind === 'mysql') this.db.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    return this.db.transaction(read)();
  }

  token(domain, value) {
    return createHmac('sha256', this.#key).update(canonical([domain, value])).digest('hex');
  }

  matchesToken(expected, supplied) {
    return typeof expected === 'string' && typeof supplied === 'string' && /^[a-f0-9]{64}$/.test(supplied) &&
      timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(supplied, 'hex'));
  }

  state(seriesId) {
    if (!seriesId) return { status: 'standalone', revision: 0 };
    const row = this.db.prepare('SELECT revision FROM series_attribute_alignment WHERE id=?').get(seriesId);
    return row ? { status: 'aligned', revision: row.revision } : { status: 'pending', revision: 0 };
  }

  markAligned(seriesId) {
    this.db.prepare('INSERT INTO series_attribute_alignment (id,revision) VALUES (?,1)').run(seriesId);
  }

  members(seriesId) {
    return this.db.prepare('SELECT id FROM project_series_members WHERE series_id=? ORDER BY id').all(seriesId).map(row => row.id);
  }

  lock(projectIds) {
    if (this.assets.lib.migrating) throw fault('数据库正在迁移，请稍后保存人物属性', 423);
    for (const id of [...new Set(projectIds)].sort()) {
      this.attributes.project(id, true);
      try { this.assets.generationLocks?.assertWritable(id); }
      catch (error) { error.project_id = id; throw error; }
    }
  }

  status(seriesId) {
    return this.read(() => {
      this.directory.series(seriesId);
      const { status, revision } = this.state(seriesId);
      return { series_id: seriesId, status, alignment_revision: revision, episode_count: this.members(seriesId).length };
    });
  }

  records(projectId) {
    return this.db.prepare(`SELECT s.id,s.revision,s.data_json,a.archived_at FROM project_character_attributes s
      JOIN creative_assets a ON a.id=s.id WHERE s.project_id=? ORDER BY s.id`).all(projectId)
      .map(({ data_json, ...record }) => ({ ...record, scores: JSON.parse(data_json) }));
  }

  episode(projectId) {
    const effective = this.attributes.effectiveConfig(projectId);
    const { config_token, config_editable, ...config } = effective;
    return {
      project_id: projectId, project_name: this.assets.project(projectId).name,
      membership_revision: this.directory.membership(projectId).revision,
      config, records: this.records(projectId),
    };
  }

  seriesContext(seriesId, projectIds) {
    const rows = this.db.prepare(`SELECT id,archived_at FROM creative_assets
      WHERE owner_type=? AND owner_id=? AND kind='character' ORDER BY id`);
    const people = [...new Set(projectIds)].flatMap(id => rows.all('project', id));
    if (!seriesId) return { people };
    people.push(...rows.all('series', seriesId));
    const scores = this.db.prepare('SELECT id,revision,data_json FROM series_character_attributes WHERE series_id=? ORDER BY id').all(seriesId);
    const overrides = this.db.prepare(`SELECT o.id,o.revision,o.value_json FROM creative_asset_overrides o
      JOIN creative_assets a ON a.id=o.asset_id
      WHERE a.owner_type='series' AND a.owner_id=? AND o.field_key LIKE 'attribute_score:%' ORDER BY o.id`).all(seriesId);
    const members = this.db.prepare('SELECT id,season_id,episode_no,revision FROM project_series_members WHERE series_id=? ORDER BY id').all(seriesId);
    const localScores = members.flatMap(row => this.records(row.id));
    return { people, scores, overrides, members, localScores };
  }

  plan(seriesId, choices, projectIds, { config, revision, contextKey } = {}) {
    const episodes = projectIds.map(id => this.episode(id));
    const context = this.seriesContext(seriesId, [...(seriesId ? this.members(seriesId) : []), ...projectIds]);
    const target = config ?? this.attributes.seriesConfig(seriesId);
    const alignmentRevision = revision ?? this.state(seriesId).revision;
    const peopleCount = { people: context.people.length, archived_people: context.people.filter(person => person.archived_at !== 0).length,
      project_count: new Set([...projectIds, ...(context.members ?? []).map(row => row.id)]).size };
    const result = planAttributeAlignment({ seriesId, alignmentRevision, config: target, episodes, choices, peopleCount });
    const snapshot = [contextKey ?? seriesId, alignmentRevision, target, episodes, context, result.view.choices];
    result.view.preview_token = result.view.ready ? this.token('series-alignment', snapshot) : null;
    return { ...result, episodes, target, snapshot };
  }

  planSeries(seriesId, input) {
    this.directory.series(seriesId);
    const { status, revision } = this.state(seriesId);
    if (status !== 'pending' || input.expected_alignment_revision !== undefined && input.expected_alignment_revision !== revision) throw stale();
    return this.plan(seriesId, input.choices, this.members(seriesId));
  }

  preview(seriesId, input) {
    if (!isRevision(input?.expected_alignment_revision) || input.choices !== undefined && !Array.isArray(input.choices)) throw invalid();
    return this.read(() => this.planSeries(seriesId, input).view);
  }

  confirm(seriesId, input) {
    if (!Array.isArray(input?.choices) || typeof input.preview_token !== 'string') throw invalid();
    return this.directory.withReceipt('attribute-alignment', seriesId, input, requestId => {
      this.lock(this.members(seriesId));
      const result = this.confirmationPlan(() => this.planSeries(seriesId, input), input.preview_token);
      if (!result.view.ready || !this.matchesToken(result.view.preview_token, input.preview_token) ||
          canonical(result.view.choices) !== canonical(input.choices)) throw stale();
      const applied = this.applySeries(seriesId, result, requestId, 'attribute_alignment');
      this.markAligned(seriesId);
      return { request_id: requestId, kind: 'attribute_alignment', series_id: seriesId,
        alignment_status: 'aligned', alignment_revision: 1, config_revision: applied.config.revision,
        history_id: applied.historyId, episodes_updated: result.episodes.length,
        scores_remapped: applied.remapped, scores_retained_in_history: applied.retained, can_undo: false };
    });
  }

  writeSeriesConfig(seriesId, target, dimensions) {
    const now = Date.now(), revision = target.revision + 1, data = {source: 'user', updated_at: now, dimensions};
    if (target.revision === 0) this.db.prepare('INSERT INTO series_attribute_configs (id,revision,data_json,created_at,updated_at) VALUES (?,?,?,?,?)')
      .run(seriesId, revision, canonical(data), now, now);
    else this.db.prepare('UPDATE series_attribute_configs SET revision=?,data_json=?,updated_at=? WHERE id=?')
      .run(revision, canonical(data), now, seriesId);
    return { series_id: seriesId, revision, ...data };
  }

  writeProjectConfig(projectId, dimensions) {
    const old = this.attributes.config(projectId);
    const revision = old.revision + 1, data = {source: 'user', updated_at: Date.now(), dimensions};
    if (old.revision === 0) this.db.prepare('INSERT INTO project_attribute_configs (id,revision,data_json) VALUES (?,?,?)')
      .run(projectId, revision, canonical(data));
    else this.db.prepare('UPDATE project_attribute_configs SET revision=?,data_json=? WHERE id=?')
      .run(revision, canonical(data), projectId);
    return { project_id: projectId, revision, ...data };
  }

  writeHistory(projectId, seriesId, historyId, requestId, kind, before, after, mappings, legacy, impact) {
    const created_at = Date.now();
    const details = { history_id: historyId, request_id: requestId, kind, created_at,
      before_configs: before, after_config: after, mappings, legacy_scores: legacy, impact };
    this.db.prepare('INSERT INTO project_attribute_history (id,history_id,request_id,kind,project_id,series_id,created_at,data_json) VALUES (?,?,?,?,?,?,?,?)')
      .run(randomUUID(), historyId, requestId, kind, projectId, seriesId, created_at, canonical(details));
  }

  applySeries(seriesId, result, requestId, kind, initial = false) {
    const config = initial || result.addedDimensions.length
      ? this.writeSeriesConfig(seriesId, initial ? defaultConfig : result.target, [...result.target.dimensions, ...result.addedDimensions])
      : { series_id: seriesId, revision: result.target.revision, source: result.target.source,
        updated_at: result.target.updated_at, dimensions: result.target.dimensions };
    const historyId = randomUUID();
    let remapped = 0, retained = 0;
    const episodes = new Map(result.episodes.map(episode => [episode.project_id, episode]));
    for (const {project_id, mappings, records} of result.projectPlans) {
      const targets = new Map(mappings.map(row => [row.source_dimension_id, row.target_dimension_id]));
      const legacy = [];
      for (const record of records) {
        const scores = Object.create(null), omitted = Object.create(null);
        for (const [id, score] of Object.entries(record.scores)) {
          const target = targets.get(id);
          if (target == null) { omitted[id] = score; retained++; }
          else {
            if (Object.hasOwn(scores, target)) throw invalid();
            scores[target] = score;
            if (id !== target) remapped++;
          }
        }
        if (canonical(scores) !== canonical(record.scores))
          this.attributes.saveScores(project_id, record.id, { revision: record.revision, scores });
        if (Object.keys(omitted).length) legacy.push({asset_id: record.id, scores: omitted});
      }
      const before = episodes.get(project_id).config;
      this.writeHistory(project_id, seriesId, historyId, requestId, kind, [before], config, mappings, legacy, this.episodeImpact(records, project_id));
    }
    const { revision, source, updated_at, dimensions } = result.target;
    this.writeHistory(null, seriesId, historyId, requestId, kind, [{series_id: seriesId, revision, source, updated_at, dimensions}], config, [], [], result.view.total_impact);
    return { historyId, config, remapped, retained };
  }

  episodeImpact(records, projectId) {
    const values = records.flatMap(record => Object.values(record.scores));
    const { people, archived_people } = this.db.prepare(`SELECT COUNT(*) people,
      COALESCE(SUM(CASE WHEN archived_at <> 0 THEN 1 ELSE 0 END),0) archived_people
      FROM creative_assets WHERE owner_type='project' AND owner_id=? AND kind='character'`).get(projectId);
    return {...zeroImpact, project_count: 1, people: Number(people), archived_people: Number(archived_people),
      scored_cells: values.filter(score => score.value !== null).length,
      manual_clear_cells: values.filter(score => score.value === null).length};
  }

  changeMode(change) {
    if (change.before.series_id === change.after.series_id) return 'unchanged';
    if (change.after.series_id !== null) return 'map_to_series';
    return this.state(change.before.series_id).status === 'aligned' ? 'copy_to_standalone' : 'keep_legacy_on_exit';
  }

  movePlan(groups, choices, request) {
    if (choices !== undefined && !Array.isArray(choices)) throw invalid();
    const selections = new Map((choices ?? []).map(choice => {
      if (!isRecord(choice) || typeof choice.group_id !== 'string' || !Array.isArray(choice.decisions) ||
          Object.keys(choice).some(key => !['group_id', 'baseline', 'decisions'].includes(key))) throw invalid();
      return [choice.group_id, choice];
    }));
    if (selections.size !== (choices?.length ?? 0)) throw invalid();
    const byTarget = Map.groupBy(groups.filter(group => group.target.series_id && group.changes.some(change => this.changeMode(change) === 'map_to_series')),
      group => group.target.series_id);
    const shared = new Map();
    for (const [seriesId, targetGroups] of byTarget) {
      if (targetGroups.length === 1 || this.state(seriesId).status === 'pending') continue;
      const projectIds = targetGroups.flatMap(group => group.changes.filter(change => this.changeMode(change) === 'map_to_series').map(change => change.project_id));
      const choices = targetGroups.flatMap(group => selections.get(group.group_id)?.decisions ?? []);
      const plan = this.plan(seriesId, choices, projectIds, {contextKey: targetGroups.map(group => group.group_id)});
      for (const [i, group] of targetGroups.entries()) shared.set(group.group_id, {plan, apply: i === 0});
    }
    const planned = groups.map(group => this.moveGroup(group, selections.get(group.group_id), shared.get(group.group_id)));
    if ([...selections.keys()].some(id => !groups.some(group => group.group_id === id))) throw invalid();
    const normalized = planned.flatMap(entry => entry.choice ? [entry.choice] : []);
    const blockers = planned.flatMap(entry => entry.blockers ?? []);
    const ready = blockers.length === 0 && planned.every(entry => entry.alignment?.view.ready !== false);
    const needsPreview = planned.some(entry => ['map_to_series', 'copy_to_standalone'].includes(entry.view.mode));
    const preview_token = ready && needsPreview
      ? this.token('attribute-move', [request, planned.map(entry => [entry.view, entry.alignment?.snapshot, entry.exits]), normalized])
      : null;
    return { view: { preview_token, groups: planned.map(entry => entry.view), choices: normalized,
      can_undo: !needsPreview, ...(needsPreview && {undo_disabled_reason: 'ATTRIBUTE_CONFIGURATION_CHANGED'}) },
    planned, blockers, ready, needsPreview };
  }

  moveGroup(group, choice, shared) {
    const {group_id, target, changes} = group;
    const targetId = target.series_id ?? null;
    const modes = new Set(changes.map(change => this.changeMode(change)));
    const mode = target.new_series || modes.has('map_to_series') ? 'map_to_series' :
      modes.has('copy_to_standalone') ? 'copy_to_standalone' :
      modes.has('keep_legacy_on_exit') ? 'keep_legacy_on_exit' : 'unchanged';
    const view = {group_id, mode, target_series_id: targetId};
    if (mode === 'unchanged' || mode === 'keep_legacy_on_exit') {
      if (choice) throw invalid();
      return {view};
    }
    if (mode === 'copy_to_standalone') {
      if (choice) throw invalid();
      const exits = changes.filter(change => this.changeMode(change) === mode).map(change => this.episode(change.project_id));
      view.exit_projects = exits.map(episode => ({
        project_id: episode.project_id, source_series_id: episode.config.series_id, config_revision: episode.config.revision,
        impact: this.episodeImpact(episode.records, episode.project_id),
      }));
      return {view, exits};
    }
    if (targetId && this.state(targetId).status === 'pending')
      return {view, blockers:[{code: 'ATTRIBUTE_ALIGNMENT_REQUIRED', group_id, series_id: targetId}]};
    const arriving = changes.filter(change => target.new_series || change.before.series_id !== targetId);
    let baseline, config;
    if (target.new_series) {
      const options = [{kind: 'default'}, ...arriving.map(change => ({kind: 'episode', project_id: change.project_id}))];
      baseline = choice?.baseline ?? (arriving.length === 1 ? options[1] : options[0]);
      if (!options.some(option => canonical(option) === canonical(baseline))) throw invalid();
      config = baseline.kind === 'episode' ? this.attributes.config(baseline.project_id) : defaultConfig;
      Object.assign(view, {baseline_options: options, baseline});
    } else if (choice?.baseline !== undefined) throw invalid();
    const alignment = shared?.plan ?? this.plan(targetId, choice?.decisions, arriving.map(change => change.project_id),
      {config, revision: target.new_series ? 1 : undefined, contextKey: group_id});
    const episodes = alignment.view.episodes.filter(episode => arriving.some(change => change.project_id === episode.project_id));
    const decisionIds = new Set(episodes.flatMap(episode => episode.decisions.map(decision => decision.item_id)));
    if (choice?.decisions.some(decision => !decisionIds.has(decision.item_id))) throw invalid();
    const decisions = alignment.view.choices.filter(decision => decisionIds.has(decision.item_id));
    view.alignment = shared ? {...alignment.view, episodes, choices: decisions} : alignment.view;
    return {view, alignment, skipApply: shared && !shared.apply, choice: {group_id, ...(baseline && {baseline}), decisions}};

  }

  confirmationPlan(plan, token) {
    try { return plan(); }
    catch (error) {
      if (token && error.code === 'ATTRIBUTE_CHOICES_INVALID') throw stale();
      throw error;
    }
  }

  assertMove(plan, input) {
    if (plan.blockers.length) throw required(plan.blockers[0].series_id);
    if (!plan.needsPreview) return;
    if (!input.attribute_preview_token) throw fault('请先预览人物属性维度对应', 409, {code: 'ATTRIBUTE_PREVIEW_REQUIRED'});
    if (!plan.ready || !this.matchesToken(plan.view.preview_token, input.attribute_preview_token) ||
        canonical(plan.view.choices) !== canonical(input.attribute_choices)) throw stale();
  }

  applyMoves(plan, requestId, seriesByGroup = new Map()) {
    const ids = [];
    if (!plan.needsPreview) return ids;
    this.lock(plan.planned.flatMap(({view, alignment, exits}) => [
      ...(alignment?.episodes.map(episode => episode.project_id) ?? []),
      ...(alignment?.addedDimensions.length && view.target_series_id ? this.members(view.target_series_id) : []),
      ...(exits?.map(episode => episode.project_id) ?? []),
    ]));
    for (const {view, alignment, exits, skipApply} of plan.planned) {
      if (alignment && !skipApply) {
        const targetId = view.target_series_id ?? seriesByGroup.get(view.group_id);
        const initial = view.target_series_id === null && view.baseline.kind === 'episode';
        const applied = this.applySeries(targetId, alignment, requestId, 'series_move', initial);
        ids.push(applied.historyId);
      }
      for (const episode of exits ?? []) {
        const config = this.writeProjectConfig(episode.project_id, episode.config.dimensions);
        const id = randomUUID();
        const mappings = config.dimensions.map(axis => ({source_dimension_id: axis.id, target_dimension_id: axis.id}));
        this.writeHistory(episode.project_id, episode.config.series_id, id, requestId, 'series_exit',
          [episode.config], config, mappings, [], view.exit_projects.find(project => project.project_id === episode.project_id).impact);
        ids.push(id);
      }
    }
    return ids;
  }

  history(scope, ownerId, query, historyId) {
    return this.read(() => {
      if (scope === 'series') this.directory.series(ownerId);
      else this.attributes.project(ownerId);
      if (historyId !== undefined && !idOK(historyId)) throw invalid();
      const limit = Number(query?.limit ?? 25);
      const offset = Number(query?.cursor ?? 0);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw invalid();
      const field = scope === 'series' ? 'series_id' : 'project_id';
      const where = field + '=?' + (scope === 'series' ? ' AND (project_id IS NULL OR project_id IN (SELECT id FROM project_series_members WHERE series_id=?))' : '');
      const params = scope === 'series' ? [ownerId, ownerId] : [ownerId];
      if (historyId !== undefined) {
        const summary = this.db.prepare('SELECT project_id,data_json FROM project_attribute_history WHERE ' + where +
          ' AND history_id=? ORDER BY CASE WHEN project_id IS NULL THEN 0 ELSE 1 END,id LIMIT 1').get(...params, historyId);
        if (!summary) throw fault('找不到该维度历史', 404, {code: 'ATTRIBUTE_HISTORY_NOT_FOUND'});
        const rows = this.db.prepare('SELECT project_id,data_json FROM project_attribute_history WHERE ' + where +
          ' AND history_id=? AND project_id IS NOT NULL ORDER BY project_id,id LIMIT ? OFFSET ?')
          .all(...params, historyId, limit + 1, offset);
        return {project_id: summary.project_id, ...JSON.parse(summary.data_json),
          projects: rows.slice(0, limit).map(row => ({project_id: row.project_id, ...JSON.parse(row.data_json)})),
          next_cursor: rows.length > limit ? String(offset + limit) : null};
      }
      const events = this.db.prepare('SELECT history_id,request_id,kind,MAX(created_at) created_at FROM project_attribute_history WHERE ' +
        where + ' GROUP BY history_id,request_id,kind ORDER BY created_at DESC,history_id LIMIT ? OFFSET ?')
        .all(...params, limit + 1, offset);
      return {items: events.slice(0, limit), next_cursor: events.length > limit ? String(offset + limit) : null};
    });
  }
}
