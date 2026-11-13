import { canonical, fault, idOK, nameKey } from "../project-assets/model.mjs";
import { SERIES_TABLES } from "./schema.mjs";

const tables = Object.keys(SERIES_TABLES).filter(table => table !== "project_series_lock");
const requestKinds = new Set(["create-series", "create-season", "create-episode", "move", "undo-move", "reorder-episodes", "reorder-seasons", "organize", "attribute-alignment"]);
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min && value < Number.MAX_SAFE_INTEGER;
const validName = value => typeof value === "string" && value.length > 0 && value.length <= 120 && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
const validTimes = row => integer(row.created_at) && integer(row.updated_at, row.created_at);
const validHash = value => typeof value === "string" && /^[a-f\d]{64}$/.test(value);
const sameKeys = (value, keys) => value && typeof value === "object" && canonical(Object.keys(value).sort()) === canonical([...keys].sort());
const bad = () => { throw fault("备份剧集目录的编号、归属或回执无效"); };

function positionValid(position) {
  if (!sameKeys(position, ["series_id", "season_id", "episode_no", "revision"])) return false;
  if (position.series_id === null) return position.season_id === null && position.episode_no === null && integer(position.revision);
  return idOK(position.series_id) && (position.season_id === null || idOK(position.season_id)) &&
    integer(position.episode_no, 1) && integer(position.revision, 1);
}

const groupIdValid = value => typeof value === "string" && value.trim().length > 0 && value.length <= 120 && !/[\x00-\x1f\x7f]/.test(value);
const changeValid = change => idOK(change.project_id) && positionValid(change.before) && positionValid(change.after) &&
  change.after.revision === change.before.revision + 1;

const attributeMoveFields = ["can_undo", "attribute_history_ids", "undo_disabled_reason"];
const validAttributeMove = result => result.can_undo === false && result.undo_disabled_reason === "ATTRIBUTE_CONFIGURATION_CHANGED" &&
  Array.isArray(result.attribute_history_ids) && result.attribute_history_ids.length > 0 &&
  result.attribute_history_ids.length <= 200 && result.attribute_history_ids.every(idOK) &&
  new Set(result.attribute_history_ids).size === result.attribute_history_ids.length;

function validOrganizeReceipt(result) {
  const baseFields = ["request_id", "created_series", "changes"];
  if (!(sameKeys(result, baseFields) || sameKeys(result, [...baseFields, ...attributeMoveFields]) && validAttributeMove(result)) || !Array.isArray(result.created_series) ||
      !Array.isArray(result.changes) || !result.changes.length || result.changes.length > 200 ||
      result.created_series.length > result.changes.length) return false;
  const targets = new Map(), projects = new Set(), createdGroups = new Set(), createdIds = new Set();
  for (const change of result.changes) {
    if (!sameKeys(change, ["group_id", "project_id", "before", "after"]) || !groupIdValid(change.group_id) ||
        !changeValid(change) || projects.has(change.project_id.toLowerCase()) || change.before.series_id !== null || change.after.series_id === null) return false;
    const target = canonical([change.after.series_id, change.after.season_id]);
    if (targets.has(change.group_id) && targets.get(change.group_id) !== target) return false;
    targets.set(change.group_id, target);
    projects.add(change.project_id.toLowerCase());
  }
  for (const entry of result.created_series) {
    if (!sameKeys(entry, ["group_id", "series"]) || !idOK(entry.series?.id) || !groupIdValid(entry.group_id) ||
        createdGroups.has(entry.group_id) || createdIds.has(entry.series.id) ||
        targets.get(entry.group_id) !== canonical([entry.series.id, null])) return false;
    createdGroups.add(entry.group_id);
    createdIds.add(entry.series.id);
  }
  return true;
}

function validReceipt(row) {
  if (!validHash(row.request_hash) || !requestKinds.has(row.kind) || !integer(row.created_at) || typeof row.result_json !== "string") return false;
  let result;
  try { result = JSON.parse(row.result_json); } catch { return false; }
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  if (row.kind === "create-series" || row.kind === "create-season") return idOK(result.id);
  if (result.request_id !== row.id) return false;
  if (row.kind === "create-episode") return idOK(result.project?.id);
  if (row.kind === "reorder-seasons") return Array.isArray(result.seasons) && result.seasons.length === 2 && result.seasons.every(season => idOK(season?.id));
  if (row.kind === "attribute-alignment") return sameKeys(result, ["request_id","kind","series_id","alignment_status",
    "alignment_revision","config_revision","history_id","episodes_updated","scores_remapped","scores_retained_in_history","can_undo"]) &&
    result.kind === "attribute_alignment" && idOK(result.series_id) && idOK(result.history_id) &&
    result.alignment_status === "aligned" && integer(result.alignment_revision, 1) && result.can_undo === false &&
    ["config_revision","episodes_updated","scores_remapped","scores_retained_in_history"].every(key => integer(result[key]));
  if (row.kind === "organize") return validOrganizeReceipt(result);
  if (row.kind === "move") {
    const baseFields = ["request_id", "changes"];
    if (!(sameKeys(result, [...baseFields, ...attributeMoveFields]) && validAttributeMove(result) ||
        sameKeys(result, [...baseFields, "can_undo", "undone_by"]) && result.can_undo === false && idOK(result.undone_by) ||
        sameKeys(result, [...baseFields, "can_undo"]) && result.can_undo === true)) return false;
  } else if (result.can_undo !== false || row.kind === "undo-move" && !idOK(result.undo_of)) return false;
  if (!Array.isArray(result.changes) || !result.changes.length || result.changes.length > 200) return false;
  const seen = new Set();
  for (const change of result.changes) {
    if (!sameKeys(change, ["project_id", "before", "after"]) || !changeValid(change) || seen.has(change.project_id)) return false;
    seen.add(change.project_id);
  }
  return true;
}

export function snapshotSeries(db) {
  const entries = tables.map(table => [table, db.prepare("SELECT * FROM " + table + " ORDER BY id").all()]);
  return entries.some(([, rows]) => rows.length) ? Object.fromEntries(entries) : undefined;
}

export function validateSeriesBackup(data, projects) {
  if (!sameKeys(data, tables)) bad();
  for (const table of tables) {
    const rows = data[table];
    if (!Array.isArray(rows) || rows.length > 100000) bad();
    const ids = new Set(), fields = Object.keys(SERIES_TABLES[table]);
    for (const row of rows) {
      if (!sameKeys(row, fields) || !idOK(row.id) || ids.has(row.id)) bad();
      ids.add(row.id);
    }
  }
  const seriesById = new Map(), seasonsById = new Map(), names = new Set(), seasonSlots = new Set(), episodeSlots = new Set();
  const projectIds = new Set(projects.filter(project => project.project_kind === "normal").map(project => project.id));
  for (const row of data.project_series) {
    if (!validName(row.name) || row.name_key !== nameKey(row.name) || names.has(row.name_key) ||
        !["", "jianying", "resolve", "other"].includes(row.software) || !integer(row.revision, 1) ||
        !integer(row.max_season_no) || !integer(row.max_root_episode_no) || !validTimes(row)) bad();
    names.add(row.name_key);
    seriesById.set(row.id, row);
  }
  for (const row of data.project_series_seasons) {
    const series = seriesById.get(row.series_id), slot = row.series_id + "/" + row.season_no;
    if (!series || !integer(row.season_no, 1) || row.season_no > series.max_season_no || seasonSlots.has(slot) ||
        row.label !== null && !validName(row.label) || !integer(row.revision, 1) || !integer(row.max_episode_no) || !validTimes(row)) bad();
    seasonSlots.add(slot);
    seasonsById.set(row.id, row);
  }
  for (const row of data.project_series_members) {
    const { id, container_key, ...position } = row;
    if (!projectIds.has(id) || !positionValid(position) || !integer(row.revision, 1) || container_key !== (row.season_id ?? "root")) bad();
    if (row.series_id === null) continue;
    const series = seriesById.get(row.series_id), season = seasonsById.get(row.season_id);
    const slot = row.series_id + "/" + container_key + "/" + row.episode_no;
    if (!series || row.season_id !== null && season?.series_id !== row.series_id ||
        row.episode_no > (season?.max_episode_no ?? series.max_root_episode_no) || episodeSlots.has(slot)) bad();
    episodeSlots.add(slot);
  }
  if (!data.project_series_requests.every(validReceipt)) bad();
}

export function restoreSeriesBackup(db, data) {
  for (const table of tables) {
    const keys = Object.keys(SERIES_TABLES[table]);
    const lookup = db.prepare("SELECT * FROM " + table + " WHERE id=?");
    const insert = db.prepare("INSERT INTO " + table + " (" + keys.join(",") + ") VALUES (" + keys.map(() => "?").join(",") + ")");
    for (const row of data[table]) {
      const existing = lookup.get(row.id);
      if (existing) {
        if (canonical(existing) !== canonical(row)) throw fault("同编号剧集目录已有不同记录，未覆盖", 409);
        continue;
      }
      try {
        insert.run(...keys.map(key => row[key]));
      } catch (error) {
        if (error.code === "SQLITE_CONSTRAINT_UNIQUE" || error.code === "ER_DUP_ENTRY") {
          throw fault("目标已有同名剧或相同编号的季、集，未覆盖", 409);
        }
        throw error;
      }
    }
  }
}
