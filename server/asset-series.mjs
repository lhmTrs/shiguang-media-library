import path from "node:path";
import { createHash } from "node:crypto";
import { cachedRead, observeDatabase } from "./read-cache.mjs";
import { pageSize, currentPage } from "./pagination.mjs";

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const videoFormats = new Set(["mp4", "mov", "m4v", "mkv", "avi", "mts", "m2ts", "webm"]);
const compareName = (a, b) => collator.compare(a.name, b.name) || collator.compare(String(a.id), String(b.id));
function compare(sort) {
  return (a, b) => {
    if (sort === "name") return compareName(a, b);
    if (sort === "revealCount") return (b.reveal_count || 0) - (a.reveal_count || 0) || -compareName(a, b);
    const field = { size: "size", recent: "mtime", createdNewest: "created_ms", createdOldest: "created_ms", capturedNewest: "captured_ms", capturedOldest: "captured_ms" }[sort];
    if (!field) return compareName(a, b);
    return Number(a[field] == null) - Number(b[field] == null) ||
      (sort.endsWith("Oldest") ? 1 : -1) * ((a[field] || 0) - (b[field] || 0)) || compareName(a, b);
  };
}
function index(lib, query) {
  const { where, values } = lib.assetFilter(query);
  const key = "asset-series:" + JSON.stringify([where, values, query.sort || "name"]);
  return cachedRead(lib.db, key, () => {
    const rows = lib.db.prepare(`SELECT id,name,path,root_id,kind,ext,reveal_count,size,mtime,created_ms,captured_ms FROM assets WHERE ${where}`).all(...values);
    rows.sort(compare(query.sort || "name"));
    const candidates = new Map();
    const identities = new Map();
    for (const row of rows) {
      if (!["sfx", "music"].includes(row.kind) || videoFormats.has(row.ext)) continue;
      const stem = row.name.slice(0, -(path.extname(row.name).length));
      const match = /^(.*\S)\s*[(（](\d{1,9})[)）]$/u.exec(stem);
      if (!match) continue;
      const name = match[1].trim();
      const identity = JSON.stringify([row.root_id, path.dirname(row.path), row.kind, row.ext, name]);
      const bucket = candidates.get(identity) || { name, rows: [], numbers: new Set() };
      bucket.rows.push(row); bucket.numbers.add(Number(match[2])); candidates.set(identity, bucket);
      identities.set(row.id, identity);
    }
    const groups = [], emitted = new Set();
    for (const row of rows) {
      const identity = identities.get(row.id), bucket = candidates.get(identity);
      if (bucket && bucket.numbers.size > 1) {
        if (emitted.has(identity)) continue;
        emitted.add(identity);
        groups.push({ key: createHash("sha256").update(identity).digest("hex"), name: bucket.name, ids: bucket.rows.map(item => item.id) });
      } else groups.push({ key: "asset:" + row.id, name: row.name, ids: [row.id] });
    }
    return { rows, groups };
  });
}
function hydrate(lib, ids) {
  if (!ids.length) return [];
  const rows = lib.db.prepare(`SELECT * FROM assets WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids);
  const byId = new Map(rows.map(row => [row.id, { ...row, tags: JSON.parse(row.tags) }]));
  const items = ids.map(id => byId.get(id)).filter(Boolean);
  for (const item of items) if ((item.probe === "pending" || item.capture_status === "pending") && item.online) lib.enqueue(item.id, true);
  return items;
}
export function naturalAssetList(lib, query) {
  const limit = pageSize(query.pageSize), { rows } = index(lib, query), page = currentPage(query.page, rows.length, limit);
  return { items: hydrate(lib, rows.slice((page - 1) * limit, page * limit).map(row => row.id)), total: rows.length, page, pages: Math.ceil(rows.length / limit), categories: lib.categoryOptions(query) };
}
export function assetSeriesList(lib, query) {
  const limit = pageSize(query.pageSize), data = index(lib, query), page = currentPage(query.page, data.groups.length, limit), groups = data.groups.slice((page - 1) * limit, page * limit);
  return { items: hydrate(lib, groups.map(group => group.ids[0])), groups: groups.map(group => ({key: group.key, name: group.name, count: group.ids.length, firstId: group.ids[0]})), total: data.rows.length, entries: data.groups.length, seriesCount: data.groups.filter(group => group.ids.length > 1).length, page, pages: Math.ceil(data.groups.length / limit), categories: lib.categoryOptions(query), revision: observeDatabase(lib.db).revision };
}
export function assetSeriesMembers(lib, query) {
  const { groups } = index(lib, query), group = groups.find(item => item.key === query.seriesKey);
  if (!group) throw Error("此系列已变化，请刷新素材列表");
  const focus = query.focusId ? group.ids.indexOf(query.focusId) : -1;
  const limit = pageSize(query.pageSize);
  const page = focus >= 0 ? Math.floor(focus / limit) + 1 : currentPage(query.memberPage, group.ids.length, limit);
  return { items: hydrate(lib, group.ids.slice((page - 1) * limit, page * limit)), total: group.ids.length, page, pages: Math.ceil(group.ids.length / limit) };
}
export function assetSeriesAdjacent(lib, query) {
  if (!["1", "-1"].includes(query.direction)) throw Error("试听方向无效");
  const limit = pageSize(query.pageSize), { groups } = index(lib, query), ordered = groups.flatMap((group, i) => group.ids.map(id => ({ id, group, page: Math.floor(i / limit) + 1 })));
  const current = ordered.findIndex(item => item.id === query.currentId);
  const direction = Number(query.direction), start = current < 0 ? (direction > 0 ? 0 : ordered.length - 1) : current + direction;
  // Offline/unplayable items are skipped without loading all full media records.
  for (let i = start; i >= 0 && i < ordered.length; i += direction) {
    const entry = ordered[i], [item] = hydrate(lib, [entry.id]);
    if (item && ["sfx", "music"].includes(item.kind) && !videoFormats.has(item.ext) && item.ext !== "ncm" && item.online)
      return { item, page: entry.page, seriesKey: entry.group.key };
  }
  return { item: null };
}
