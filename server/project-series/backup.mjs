import { canonical, fault, idOK, nameKey } from "../project-assets/model.mjs";
import { SERIES_TABLES } from "./schema.mjs";

const tables = Object.keys(SERIES_TABLES).filter(table => table !== "project_series_lock");
const requestKinds = new Set(["create-series", "create-season", "create-episode", "move", "undo-move", "reorder-episodes", "reorder-seasons"]);
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

function validReceipt(row) {
  if (!validHash(row.request_hash) || !requestKinds.has(row.kind) || !integer(row.created_at) || typeof row.result_json !== "string") return false;
  let result;
  try { result = JSON.parse(row.result_json); } catch { return false; }
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  if (row.kind === "create-series" || row.kind === "create-season") return idOK(result.id);
  if (result.request_id !== row.id) return false;
  if (row.kind === "create-episode") return idOK(result.project?.id);
  if (row.kind === "reorder-seasons") return Array.isArray(result.seasons) && result.seasons.length === 2 && result.seasons.every(season => idOK(season?.id));
  if (row.kind === "move") {
    if (result.can_undo !== true && !(result.can_undo === false && idOK(result.undone_by))) return false;
  } else if (result.can_undo !== false || row.kind === "undo-move" && !idOK(result.undo_of)) return false;
  if (!Array.isArray(result.changes) || !result.changes.length || result.changes.length > 200) return false;
  const seen = new Set();
  for (const change of result.changes) {
    if (!sameKeys(change, ["project_id", "before", "after"]) || !idOK(change.project_id) || seen.has(change.project_id) ||
        !positionValid(change.before) || !positionValid(change.after) || change.after.revision !== change.before.revision + 1) return false;
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
