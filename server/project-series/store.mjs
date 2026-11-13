import { randomUUID } from "node:crypto";
import { digest, idOK, nameKey } from "../project-assets/model.mjs";
import { ensureSeriesSchema, lockSeriesDirectory } from "./schema.mjs";

const maxNumber = Number.MAX_SAFE_INTEGER - 1;
const softwareOptions = ["", "jianying", "resolve", "other"];
const rootKey = "root";
const ungrouped = { series_id: null, season_id: null, episode_no: null, revision: 0 };
const mysqlLock = db => db.kind === "mysql" ? " FOR UPDATE" : "";
const containerKey = position => position.season_id ?? rootKey;
const slot = position => JSON.stringify([position.series_id, containerKey(position), position.episode_no]);
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);

export class SeriesError extends Error {
  constructor(code, message, status = 409, details) {
    super(message);
    Object.assign(this, { code, status, details });
  }
}

function invalid(message) {
  throw new SeriesError("INVALID_SERIES_INPUT", message, 400);
}

function organizeConflict(conflicts) {
  return new SeriesError("SERIES_ORGANIZE_CONFLICT", "归组有冲突，请核对后重新提交", 409, { conflicts });
}

function identifier(value, label) {
  if (!idOK(value)) invalid(label + "无效");
  return value;
}

function number(value, label, min = 1) {
  if (!Number.isSafeInteger(value) || value < min || value > maxNumber) invalid(label + "超出范围");
  return value;
}

function label(value, field) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 120 || /[\x00-\x1f\x7f]/.test(value)) {
    invalid(field + "格式不正确，最多 120 字");
  }
  return value.trim();
}

function editor(value) {
  if (!softwareOptions.includes(value)) invalid("请选择有效的剪辑软件");
  return value;
}

function checkRevision(row, expected) {
  if (Number(row.revision) !== number(expected, "版本")) {
    throw new SeriesError("SERIES_STALE", "目录已修改，请刷新后重试");
  }
}

function validateOrganizeGroups(groups) {
  if (!Array.isArray(groups) || !groups.length || groups.length > 200) invalid("请选择 1–200 个项目归组");
  const groupIds = new Set(), projectIds = new Set();
  for (const group of groups) {
    if (!record(group)) invalid("归组格式不正确");
    const { group_id, target, items } = group;
    label(group_id, "分组编号");
    if (group_id.length > 120 || groupIds.has(group_id)) invalid("分组编号无效或重复");
    groupIds.add(group_id);
    if (!record(target)) invalid("请选择目标剧或季");
    if (Object.hasOwn(target, "new_series")) {
      if (!record(target.new_series) || Object.hasOwn(target, "series_id") || Object.hasOwn(target, "season_id")) {
        invalid("请选择一个现有目标或新建一部剧");
      }
      label(target.new_series.name, "剧名");
      editor(target.new_series.software ?? "");
    } else {
      identifier(target.series_id, "剧编号");
      if (target.season_id !== null) identifier(target.season_id, "季编号");
    }
    if (!Array.isArray(items) || !items.length || items.length > 200) invalid("每组须选择 1–200 个项目");
    for (const item of items) {
      if (!record(item)) invalid("项目归组格式不正确");
      const id = identifier(item.project_id, "项目编号").toLowerCase();
      if (projectIds.has(id)) invalid("同一项目不能重复选择");
      projectIds.add(id);
      if (projectIds.size > 200) invalid("一批最多归组 200 个项目");
      number(item.expected_revision, "归组版本", 0);
      number(item.episode_no, "集号");
    }
  }
}

function positionOf(row) {
  return row ? {
    series_id: row.series_id, season_id: row.season_id,
    episode_no: row.episode_no === null ? null : Number(row.episode_no),
    revision: Number(row.revision),
  } : { ...ungrouped };
}

function seasonView(row) {
  return {
    id: row.id, series_id: row.series_id, season_no: Number(row.season_no),
    label: row.label, revision: Number(row.revision),
    created_at: Number(row.created_at), updated_at: Number(row.updated_at),
    next_episode_no: Number(row.max_episode_no) + 1,
  };
}

function seriesView(row, seasons) {
  return {
    id: row.id, name: row.name, software: row.software, revision: Number(row.revision),
    created_at: Number(row.created_at), updated_at: Number(row.updated_at),
    next_season_no: Number(row.max_season_no) + 1,
    next_episode_no: Number(row.max_root_episode_no) + 1, seasons,
  };
}

export class ProjectSeries {
  constructor(projects) {
    this.projects = projects;
  }

  get db() { return this.projects.lib.db; }

  init() {
    ensureSeriesSchema(this.db);
    return this;
  }

  transaction(action) {
    const run = this.db.transaction(() => {
      lockSeriesDirectory(this.db);
      return action();
    });
    return (run.immediate ?? run)();
  }

  list() {
    const rows = this.db.prepare(`SELECT p.*,s.id season_id,s.season_no,s.label,s.revision season_revision,
      s.created_at season_created_at,s.updated_at season_updated_at,s.max_episode_no
      FROM project_series p LEFT JOIN project_series_seasons s ON s.series_id=p.id
      ORDER BY p.created_at,p.id,s.season_no`).all();
    const directory = new Map();
    for (const row of rows) {
      if (!directory.has(row.id)) directory.set(row.id, seriesView(row, []));
      if (row.season_id !== null) directory.get(row.id).seasons.push(seasonView({
        id: row.season_id, series_id: row.id, season_no: row.season_no, label: row.label,
        revision: row.season_revision, created_at: row.season_created_at, updated_at: row.season_updated_at,
        max_episode_no: row.max_episode_no,
      }));
    }
    return [...directory.values()];
  }

  series(id) {
    const row = this.db.prepare("SELECT * FROM project_series WHERE id=?").get(identifier(id, "剧编号"));
    if (!row) throw new SeriesError("SERIES_NOT_FOUND", "剧不存在或已删除", 404);
    return row;
  }

  season(seriesId, id) {
    const row = this.db.prepare("SELECT * FROM project_series_seasons WHERE series_id=? AND id=?").get(seriesId, identifier(id, "季编号"));
    if (!row) throw new SeriesError("SEASON_NOT_FOUND", "目标季不存在或已移除", 404);
    return row;
  }

  seasons(seriesId) {
    return this.db.prepare("SELECT * FROM project_series_seasons WHERE series_id=? ORDER BY season_no").all(seriesId).map(seasonView);
  }

  membership(id) {
    return positionOf(this.db.prepare("SELECT * FROM project_series_members WHERE id=?").get(id));
  }

  request(id) {
    const row = this.db.prepare("SELECT result_json FROM project_series_requests WHERE id=?").get(identifier(id, "请求编号"));
    return row ? { found: true, result: JSON.parse(row.result_json) } : { found: false };
  }

  withReceipt(kind, target, input, action) {
    const id = identifier(input.request_id, "请求编号");
    const hash = digest({ kind, target, input });
    return this.transaction(() => {
      const prior = this.db.prepare("SELECT request_hash,result_json FROM project_series_requests WHERE id=?").get(id);
      if (prior) {
        if (prior.request_hash !== hash) throw new SeriesError("SERIES_REQUEST_CONFLICT", "请求编号已用于不同操作");
        return JSON.parse(prior.result_json);
      }
      const result = action(id);
      this.db.prepare("INSERT INTO project_series_requests (id,request_hash,kind,result_json,created_at) VALUES (?,?,?,?,?)")
        .run(id, hash, kind, JSON.stringify(result), Date.now());
      return result;
    });
  }

  assertSeriesNameAvailable(name, id) {
    const existing = this.db.prepare("SELECT id FROM project_series WHERE name_key=?").get(nameKey(name));
    if (existing && existing.id !== id) throw new SeriesError("SERIES_NAME_CONFLICT", "剧名已存在，请换一个名称");
  }

  insertSeries(input) {
    const name = label(input.name, "剧名"), software = editor(input.software ?? "");
    this.assertSeriesNameAvailable(name);
    const id = randomUUID(), now = Date.now();
    this.db.prepare("INSERT INTO project_series (id,name,name_key,software,revision,max_season_no,max_root_episode_no,created_at,updated_at) VALUES (?,?,?,?,1,0,0,?,?)")
      .run(id, name, nameKey(name), software, now, now);
    return id;
  }

  createSeries(input) {
    return this.withReceipt("create-series", null, input, () => seriesView(this.series(this.insertSeries(input)), []));
  }

  updateSeries(id, input) {
    return this.transaction(() => {
      const row = this.series(id);
      checkRevision(row, input.expected_revision);
      const name = input.name === undefined ? row.name : label(input.name, "剧名");
      const software = input.software === undefined ? row.software : editor(input.software);
      this.assertSeriesNameAvailable(name, id);
      this.db.prepare("UPDATE project_series SET name=?,name_key=?,software=?,revision=revision+1,updated_at=? WHERE id=?")
        .run(name, nameKey(name), software, Date.now(), id);
      return seriesView(this.series(id), this.seasons(id));
    });
  }

  removeSeries(id, input) {
    return this.transaction(() => {
      checkRevision(this.series(id), input.expected_revision);
      if (this.db.prepare("SELECT id FROM project_series_members WHERE series_id=? LIMIT 1").get(id)) {
        throw new SeriesError("SERIES_NOT_EMPTY", "剧中仍有项目，请先移出项目");
      }
      this.projects.lib.creativeAssetStore?.scopedWrites.assertSeriesRemovable(id);
      this.db.prepare("DELETE FROM project_series_seasons WHERE series_id=?").run(id);
      this.db.prepare("DELETE FROM project_series WHERE id=?").run(id);
      return { removed: true };
    });
  }

  assertSeasonNumberAvailable(seriesId, seasonNo, id) {
    const existing = this.db.prepare("SELECT id FROM project_series_seasons WHERE series_id=? AND season_no=?").get(seriesId, seasonNo);
    if (existing && existing.id !== id) throw new SeriesError("SEASON_NUMBER_CONFLICT", "该季号已被使用", 409, { season_no: seasonNo });
  }

  recordSeasonNumber(seriesId, seasonNo) {
    this.db.prepare("UPDATE project_series SET max_season_no=? WHERE id=? AND max_season_no<?").run(seasonNo, seriesId, seasonNo);
  }

  createSeason(seriesId, input) {
    return this.withReceipt("create-season", seriesId, input, () => {
      const series = this.series(seriesId);
      const seasonNo = number(input.season_no === undefined ? Number(series.max_season_no) + 1 : input.season_no, "季号");
      const name = input.label == null ? null : label(input.label, "季名称");
      this.assertSeasonNumberAvailable(seriesId, seasonNo);
      const id = randomUUID(), now = Date.now();
      this.db.prepare("INSERT INTO project_series_seasons (id,series_id,season_no,label,revision,max_episode_no,created_at,updated_at) VALUES (?,?,?,?,1,0,?,?)")
        .run(id, seriesId, seasonNo, name, now, now);
      this.recordSeasonNumber(seriesId, seasonNo);
      return seasonView(this.season(seriesId, id));
    });
  }

  updateSeason(seriesId, id, input) {
    return this.transaction(() => {
      this.series(seriesId);
      const row = this.season(seriesId, id);
      checkRevision(row, input.expected_revision);
      const seasonNo = input.season_no === undefined ? Number(row.season_no) : number(input.season_no, "季号");
      const name = input.label === undefined ? row.label : input.label === null ? null : label(input.label, "季名称");
      this.assertSeasonNumberAvailable(seriesId, seasonNo, id);
      this.db.prepare("UPDATE project_series_seasons SET season_no=?,label=?,revision=revision+1,updated_at=? WHERE id=?")
        .run(seasonNo, name, Date.now(), id);
      this.recordSeasonNumber(seriesId, seasonNo);
      return seasonView(this.season(seriesId, id));
    });
  }

  removeSeason(seriesId, id, input) {
    return this.transaction(() => {
      this.series(seriesId);
      checkRevision(this.season(seriesId, id), input.expected_revision);
      if (this.db.prepare("SELECT id FROM project_series_members WHERE series_id=? AND container_key=? LIMIT 1").get(seriesId, id)) {
        throw new SeriesError("SEASON_NOT_EMPTY", "季中仍有项目，请先移出项目");
      }
      this.projects.lib.creativeAssetStore?.scopedWrites.assertNoOverrides('season', id);
      this.db.prepare("DELETE FROM project_series_seasons WHERE id=?").run(id);
      return { removed: true };
    });
  }

  writeMembership(id, after) {
    this.db.prepare("INSERT INTO project_series_members (id,series_id,season_id,container_key,episode_no,revision) VALUES (?,?,?,?,?,?)")
      .run(id, after.series_id, after.season_id, containerKey(after), after.episode_no, after.revision);
    if (after.season_id !== null) {
      this.db.prepare("UPDATE project_series_seasons SET max_episode_no=? WHERE id=? AND max_episode_no<?")
        .run(after.episode_no, after.season_id, after.episode_no);
    } else if (after.series_id !== null) {
      this.db.prepare("UPDATE project_series SET max_root_episode_no=? WHERE id=? AND max_root_episode_no<?")
        .run(after.episode_no, after.series_id, after.episode_no);
    }
  }

  createEpisode(seriesId, input) {
    return this.withReceipt("create-episode", seriesId, input, requestId => {
      const series = this.series(seriesId);
      const season = input.season_id === null ? null : this.season(seriesId, input.season_id);
      const episodeNo = Number(season ? season.max_episode_no : series.max_root_episode_no) + 1;
      if (number(input.expected_episode_no, "集号") !== episodeNo) {
        throw new SeriesError("NEXT_EPISODE_CHANGED", "下一集号已变化，请核对后重试", 409, { next_episode_no: episodeNo });
      }
      const seasonName = season ? " 第" + season.season_no + "季" : "";
      const name = label(input.name === undefined ? series.name + seasonName + " 第" + episodeNo + "集" : input.name, "项目名");
      if (this.db.prepare("SELECT id FROM media_projects WHERE name=?").get(name)) {
        throw new SeriesError("PROJECT_NAME_CONFLICT", "项目名称已存在，请另填名称");
      }
      let project;
      try {
        project = this.projects.saveUnlocked(null, { name, software: series.software });
      } catch (error) {
        if (error.code === "ER_DUP_ENTRY" || error.code === "SQLITE_CONSTRAINT_UNIQUE") {
          throw new SeriesError("PROJECT_NAME_CONFLICT", "项目名称已存在，请另填名称");
        }
        throw error;
      }
      const position = { series_id: seriesId, season_id: input.season_id, episode_no: episodeNo, revision: 1 };
      this.writeMembership(project.id, position);
      const { revision: membership_revision, ...membership } = position;
      return { request_id: requestId, project: { ...project, ...membership, membership_revision, candidates: 0, used: 0, total: 0 } };
    });
  }

  target(value) {
    if (!value || !Object.hasOwn(value, "series_id") || !Object.hasOwn(value, "season_id")) invalid("请选择目标剧或季");
    const { series_id, season_id } = value;
    if (series_id === null) {
      if (season_id !== null) invalid("季必须属于目标剧");
    } else {
      this.series(series_id);
      if (season_id !== null) this.season(series_id, season_id);
    }
    return { series_id, season_id };
  }

  planMove(input) {
    const target = this.target(input.target);
    const { changes, conflicts } = this.planMembership(target, input.items);
    conflicts.push(...this.numberConflicts(changes));
    return { ready: conflicts.length === 0, changes, conflicts };
  }

  planMembership(target, items, ungroupedOnly = false) {
    if (!Array.isArray(items) || !items.length || items.length > 200) invalid("请选择 1–200 个项目");
    const seen = new Set(), conflicts = [], changes = [];
    for (const item of items) {
      const id = identifier(item?.project_id, "项目编号");
      if (seen.has(id)) invalid("同一项目不能重复选择");
      seen.add(id);
      const expected = number(item.expected_revision, "归组版本", 0);
      if (item.episode_no !== undefined) {
        if (target.series_id === null) invalid("移出剧时不填写集号");
        number(item.episode_no, "集号");
      }
      const project = this.db.prepare("SELECT id FROM media_projects WHERE id=? AND project_kind='normal'").get(id);
      if (!project) {
        conflicts.push({ project_id: id, code: "PROJECT_NOT_FOUND" });
        continue;
      }
      const before = this.membership(id);
      if (before.revision !== expected || (ungroupedOnly && before.series_id !== null)) {
        conflicts.push({ project_id: id, code: "SERIES_STALE" });
        continue;
      }
      const episodeNo = target.series_id === null ? null : item.episode_no ?? before.episode_no;
      if (episodeNo === null && target.series_id !== null) {
        conflicts.push({ project_id: id, code: "INVALID_SERIES_INPUT", ...target });
        continue;
      }
      const change = { project_id: id, before, after: { ...target, episode_no: episodeNo, revision: before.revision + 1 } };
      try { this.projects.lib.creativeAssetStore?.scopedWrites.assertMembershipChange(change); }
      catch (error) {
        if (!['ASSET_IN_USE', 'ASSET_SCOPE_CHANGED', 'ASSET_NAME_CONFLICT'].includes(error.code)) throw error;
        conflicts.push({ project_id: id, code: error.code, ...error.details });
        continue;
      }
      changes.push(change);
    }
    return { changes, conflicts };
  }

  numberConflicts(changes) {
    const moving = new Set(changes.map(change => change.project_id));
    const occupied = new Map(), conflicts = [];
    const currentOwner = this.db.prepare("SELECT id FROM project_series_members WHERE series_id=? AND container_key=? AND episode_no=?");
    for (const { project_id, after } of changes) {
      if (after.series_id === null) continue;
      const key = slot(after);
      const existing = currentOwner.get(after.series_id, containerKey(after), after.episode_no)?.id;
      const blocking = existing && !moving.has(existing) ? existing : occupied.get(key);
      if (blocking) {
        conflicts.push({
          project_id, code: "EPISODE_NUMBER_CONFLICT", series_id: after.series_id, season_id: after.season_id,
          episode_no: after.episode_no, conflicting_project_id: blocking,
        });
      }
      if (!occupied.has(key)) occupied.set(key, project_id);
    }
    return conflicts;
  }

  applyChanges(changes) {
    const remove = this.db.prepare("DELETE FROM project_series_members WHERE id=?");
    const project = this.db.prepare("SELECT id FROM media_projects WHERE id=? AND project_kind='normal'" + mysqlLock(this.db));
    const byProject = new Map(changes.map(change => [change.project_id, change]));
    for (const id of [...byProject.keys()].sort()) {
      try {
        if (!project.get(id)) throw new SeriesError("PROJECT_NOT_FOUND", "项目已删除，请刷新后重试", 404);
        this.projects.generationLocks?.assertWritable(id);
        this.projects.lib.creativeAssetStore?.scopedWrites.assertMembershipChange(byProject.get(id));
      } catch (error) {
        const { group_id } = byProject.get(id);
        if (group_id === undefined || !["PROJECT_NOT_FOUND", "STORYBOARD_GENERATION_LOCKED"].includes(error.code)) throw error;
        throw organizeConflict([{ group_id, project_id: id, code: error.code }]);
      }
      remove.run(id);
    }
    for (const { project_id, after } of changes) this.writeMembership(project_id, after);
  }

  previewMove(input) {
    return this.transaction(() => this.planMove(input));
  }

  move(input) {
    return this.withReceipt("move", null, input, requestId => {
      const { changes, conflicts } = this.planMove(input);
      if (conflicts.length) {
        const codes = conflicts.map(conflict => conflict.code);
        const code = ["ASSET_IN_USE", "ASSET_SCOPE_CHANGED", "ASSET_NAME_CONFLICT", "EPISODE_NUMBER_CONFLICT", "SERIES_STALE", "PROJECT_NOT_FOUND", "INVALID_SERIES_INPUT"].find(candidate => codes.includes(candidate));
        const status = code === "PROJECT_NOT_FOUND" ? 404 : code === "INVALID_SERIES_INPUT" ? 400 : 409;
        throw new SeriesError(code, "部分项目无法移动，请核对冲突后重试", status, { conflicts });
      }
      this.applyChanges(changes);
      return { request_id: requestId, changes, can_undo: true };
    });
  }

  organize(input) {
    return this.withReceipt("organize", null, input, requestId => {
      validateOrganizeGroups(input.groups);
      const changes = [], conflicts = [], created = [];
      for (const { group_id, target, items } of input.groups) {
        let position;
        try {
          if (target.new_series) {
            const id = this.insertSeries(target.new_series);
            created.push({ group_id, id });
            position = { series_id: id, season_id: null };
          } else {
            const series = this.series(target.series_id);
            const season = target.season_id === null ? null : this.season(series.id, target.season_id);
            position = { series_id: series.id, season_id: season?.id ?? null };
          }
        } catch (error) {
          if (!(error instanceof SeriesError) || !["SERIES_NAME_CONFLICT", "SERIES_NOT_FOUND", "SEASON_NOT_FOUND"].includes(error.code)) throw error;
          const { series_id, season_id } = target;
          conflicts.push({ group_id, code: error.code, ...(series_id && { series_id, season_id }) });
          continue;
        }
        const planned = this.planMembership(position, items, true);
        changes.push(...planned.changes.map(change => ({ group_id, ...change })));
        conflicts.push(...planned.conflicts.map(conflict => ({ group_id, ...conflict })));
      }
      const groupByProject = new Map(changes.map(change => [change.project_id, change.group_id]));
      conflicts.push(...this.numberConflicts(changes).map(conflict => ({ group_id: groupByProject.get(conflict.project_id), ...conflict })));
      if (conflicts.length) throw organizeConflict(conflicts);

      this.applyChanges(changes);
      const created_series = created.map(({ group_id, id }) => ({ group_id, series: seriesView(this.series(id), []) }));
      return { request_id: requestId, created_series, changes };
    });
  }

  undo(originalId, input) {
    identifier(originalId, "原请求编号");
    return this.withReceipt("undo-move", originalId, input, requestId => {
      const original = this.db.prepare("SELECT result_json,kind FROM project_series_requests WHERE id=?").get(originalId);
      if (original?.kind !== "move") throw new SeriesError("SERIES_REQUEST_NOT_FOUND", "找不到可撤销的移动记录", 404);
      const receipt = JSON.parse(original.result_json);
      if (!receipt.can_undo) throw new SeriesError("SERIES_UNDO_CONFLICT", "这批移动已撤销");
      const conflicts = [], changes = [];
      for (const change of receipt.changes) {
        const { project_id, before, after } = change;
        const current = this.membership(project_id);
        if (current.revision !== after.revision || slot(current) !== slot(after)) {
          conflicts.push({ project_id, code: "SERIES_STALE" });
          continue;
        }
        try {
          this.target(before);
        } catch (error) {
          if (!(error instanceof SeriesError)) throw error;
          conflicts.push({ project_id, code: error.code, series_id: before.series_id, season_id: before.season_id });
          continue;
        }
        changes.push({ project_id, before: current, after: { ...before, revision: current.revision + 1 } });
      }
      conflicts.push(...this.numberConflicts(changes));
      if (conflicts.length) throw new SeriesError("SERIES_UNDO_CONFLICT", "项目或原位置已有变化，未撤销本批移动", 409, { conflicts });
      this.applyChanges(changes);
      const updated = { ...receipt, can_undo: false, undone_by: requestId };
      this.db.prepare("UPDATE project_series_requests SET result_json=? WHERE id=?").run(JSON.stringify(updated), originalId);
      return { request_id: requestId, undo_of: originalId, changes, can_undo: false };
    });
  }

  neighbor(rows, id, input) {
    if (!["previous", "next"].includes(input.direction)) invalid("换序方向无效");
    const expected = number(input.expected_revision, "版本", 0);
    const expectedNeighbor = identifier(input.expected_neighbor_id, "相邻项编号");
    const expectedNeighborRevision = number(input.expected_neighbor_revision, "相邻项版本", 0);
    const index = rows.findIndex(row => row.id === id);
    const row = rows[index], neighbor = rows[index + (input.direction === "next" ? 1 : -1)];
    if (!row || !neighbor || Number(row.revision) !== expected || neighbor.id !== expectedNeighbor ||
        Number(neighbor.revision) !== expectedNeighborRevision) {
      throw new SeriesError("SERIES_REORDER_CHANGED", "相邻顺序已变化，请刷新后重试");
    }
    return [row, neighbor];
  }

  reorderEpisodes(id, input) {
    identifier(id, "项目编号");
    return this.withReceipt("reorder-episodes", id, input, requestId => {
      const current = this.membership(id);
      if (current.series_id === null) throw new SeriesError("SERIES_REORDER_CHANGED", "该项目不在剧或季内");
      const rows = this.db.prepare("SELECT * FROM project_series_members WHERE series_id=? AND container_key=? ORDER BY episode_no")
        .all(current.series_id, containerKey(current));
      const [row, neighbor] = this.neighbor(rows, id, input);
      const changes = [[row, neighbor], [neighbor, row]].map(([a, b]) => {
        const before = positionOf(a);
        return { project_id: a.id, before, after: { ...before, episode_no: Number(b.episode_no), revision: before.revision + 1 } };
      });
      this.applyChanges(changes);
      return { request_id: requestId, changes, can_undo: false };
    });
  }

  reorderSeasons(seriesId, id, input) {
    identifier(id, "季编号");
    return this.withReceipt("reorder-seasons", [seriesId, id], input, requestId => {
      this.series(seriesId);
      const rows = this.db.prepare("SELECT * FROM project_series_seasons WHERE series_id=? ORDER BY season_no").all(seriesId);
      const [row, neighbor] = this.neighbor(rows, id, input);
      const now = Date.now();
      // Zero is outside the selectable range. It frees the first slot inside this transaction.
      this.db.prepare("UPDATE project_series_seasons SET season_no=0 WHERE id=?").run(id);
      const update = this.db.prepare("UPDATE project_series_seasons SET season_no=?,revision=revision+1,updated_at=? WHERE id=?");
      update.run(row.season_no, now, neighbor.id);
      update.run(neighbor.season_no, now, id);
      return { request_id: requestId, seasons: [this.season(seriesId, id), this.season(seriesId, neighbor.id)].map(seasonView) };
    });
  }
}
