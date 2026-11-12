import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import { creativeFixture } from "./helpers/creative-fixture.mjs";
import { digest } from "../server/project-assets/model.mjs";
import { projectSeriesRouter } from "../server/project-series/router.mjs";
import { SERIES_TABLES, seriesConstraints } from "../server/project-series/schema.mjs";
import { mysqlColumnType } from "../server/mysql.mjs";

async function setup(t) {
  const fixture = await creativeFixture();
  t.after(fixture.close);
  return { ...fixture, series: fixture.projects.series };
}

const root = series => ({ series_id: series.id, season_id: null });
const outside = { series_id: null, season_id: null };
const inSeason = season => ({ series_id: season.series_id, season_id: season.id });
const createDrama = (series, name = "测试剧集") => series.createSeries({ name, request_id: randomUUID(), software: "resolve" });
const episode = (series, target, episodeNo, extra = {}) => series.createEpisode(target.series_id, {
  season_id: target.season_id, expected_episode_no: episodeNo, request_id: randomUUID(), ...extra,
}).project;
const item = (project, number) => ({
  project_id: project.id, expected_revision: project.membership_revision ?? 0,
  ...(number === undefined ? {} : { episode_no: number }),
});
const move = (series, target, items) => series.move({ target, items, request_id: randomUUID() });
const listed = (projects, project) => projects.list().find(row => row.id === project.id);

test("empty containers, independent numbering and stable project references", async t => {
  const { series, projects, store, a } = await setup(t);
  const drama = createDrama(series);
  assert.deepEqual(series.list(), [drama]);
  assert.deepEqual(projects.list().map(row => [row.series_id, row.season_id, row.episode_no, row.membership_revision]),
    [[null, null, null, 0], [null, null, null, 0]]);
  const first = series.createSeason(drama.id, { request_id: randomUUID() });
  const third = series.createSeason(drama.id, { request_id: randomUUID(), season_no: 3, label: "番外" });
  assert.equal(projects.list().length, 2);
  assert.equal(series.list()[0].next_season_no, 4);
  const top = episode(series, root(drama), 1);
  const nested = episode(series, inSeason(first), 1);
  const thirdEpisode = episode(series, inSeason(third), 1);
  assert.deepEqual([top.name, nested.name, thirdEpisode.name], ["测试剧集 第1集", "测试剧集 第1季 第1集", "测试剧集 第3季 第1集"]);
  assert.equal(nested.software, "resolve");
  assert.equal(listed(projects, nested).season_id, first.id);
  assert.throws(() => episode(series, inSeason(first), 1), {
    code: "NEXT_EPISODE_CHANGED", details: { next_episode_no: 2 },
  });
  assert.throws(() => series.removeSeason(drama.id, first.id, { expected_revision: 1 }), { code: "SEASON_NOT_EMPTY" });
  assert.throws(() => series.removeSeries(drama.id, { expected_revision: 1 }), { code: "SERIES_NOT_EMPTY" });
  const asset = await store.create({ kind: "character", name: "合成角色", project_id: a.id });
  move(series, inSeason(first), [item(a, 6)]);
  const renamed = series.updateSeries(drama.id, { expected_revision: 1, name: "修改剧名" });
  assert.equal(renamed.name, "修改剧名");
  assert.equal(renamed.seasons[0].next_episode_no, 7);
  assert.equal(projects.get(a.id).name, a.name);
  assert.equal(store.get(asset.id).project_id, a.id);
  assert.throws(() => projects.remove(a.id), { status: 409 });
  assert.equal(listed(projects, a).episode_no, 6);
  move(series, outside, [item(listed(projects, a))]);
  assert.deepEqual(series.membership(a.id), { ...outside, episode_no: null, revision: 2 });
  assert.equal(series.list()[0].seasons[0].next_episode_no, 7);
  projects.remove(top.id);
  assert.equal(series.membership(top.id).revision, 0);
  assert.equal(series.list()[0].next_episode_no, 2);
});

test("batch move preserves all prior positions on conflict and undo requires the exact after-image", async t => {
  const { series, projects, a, b } = await setup(t);
  const drama = createDrama(series);
  const season = series.createSeason(drama.id, { request_id: randomUUID() });
  const original = episode(series, root(drama), 1);
  const blocked = { target: root(drama), items: [item(a, 1), item(b, 2)], request_id: randomUUID() };
  const preview = series.previewMove(blocked);
  assert.equal(preview.ready, false);
  assert.deepEqual(preview.conflicts, [{
    project_id: a.id, code: "EPISODE_NUMBER_CONFLICT", ...root(drama), episode_no: 1, conflicting_project_id: original.id,
  }]);
  assert.throws(() => series.move(blocked), { code: "EPISODE_NUMBER_CONFLICT", details: { conflicts: preview.conflicts } });
  assert.equal(listed(projects, b).membership_revision, 0);
  assert.deepEqual(series.request(blocked.request_id), { found: false });
  const input = { target: inSeason(season), items: [item(a, 1), item(b, 2)], request_id: randomUUID() };
  const moved = series.move(input);
  assert.deepEqual(series.move(input), moved);
  assert.deepEqual(series.request(input.request_id), { found: true, result: moved });
  assert.throws(() => series.move({ ...input, items: [item(a, 1)] }), { code: "SERIES_REQUEST_CONFLICT" });
  const undoInput = { request_id: randomUUID() };
  const undo = series.undo(moved.request_id, undoInput);
  assert.deepEqual(series.undo(moved.request_id, undoInput), undo);
  assert.equal(series.request(input.request_id).result.undone_by, undoInput.request_id);
  assert.equal(series.request(input.request_id).result.can_undo, false);
  assert.deepEqual([listed(projects, a).membership_revision, listed(projects, b).membership_revision], [2, 2]);
  assert.throws(() => series.move({ ...input, request_id: randomUUID() }), { code: "SERIES_STALE" });

  const grouped = move(series, root(drama), [item(listed(projects, a), 4), item(listed(projects, b), 5)]);
  const across = move(series, inSeason(season), grouped.changes.map(change => ({
    project_id: change.project_id, expected_revision: change.after.revision,
  })));
  const occupant = projects.save(null, { name: "原位置后来被占用" });
  move(series, root(drama), [item(occupant, 4)]);
  const requestId = randomUUID();
  assert.throws(() => series.undo(across.request_id, { request_id: requestId }), error =>
    error.code === "SERIES_UNDO_CONFLICT" && error.details.conflicts[0].conflicting_project_id === occupant.id);
  assert.equal(listed(projects, b).season_id, season.id);
  assert.equal(series.request(requestId).found, false);
  move(series, outside, [item(listed(projects, occupant))]);
  move(series, inSeason(season), [item(listed(projects, a), 8)]);
  move(series, inSeason(season), [item(listed(projects, a), 4)]);
  assert.throws(() => series.undo(across.request_id, { request_id: randomUUID() }), { code: "SERIES_UNDO_CONFLICT" });
  assert.equal(listed(projects, b).season_id, season.id);
});

test("episodes and seasons swap the visible neighbor across gaps, and stale neighbors cannot swap", async t => {
  const { series, projects, a, b } = await setup(t);
  const drama = createDrama(series);
  const one = series.createSeason(drama.id, { request_id: randomUUID() });
  const four = series.createSeason(drama.id, { request_id: randomUUID(), season_no: 4 });
  move(series, inSeason(one), [item(a, 2), item(b, 6)]);
  const payload = (neighborId, expected = 1) => ({
    request_id: randomUUID(), direction: "next", expected_revision: 1, expected_neighbor_id: neighborId, expected_neighbor_revision: expected,
  });
  assert.throws(() => series.reorderEpisodes(a.id, payload(b.id, 0)), { code: "SERIES_REORDER_CHANGED" });
  const reordered = series.reorderEpisodes(a.id, payload(b.id));
  assert.deepEqual(reordered.changes.map(change => change.after.episode_no), [6, 2]);
  const seasons = series.reorderSeasons(drama.id, one.id, payload(four.id)).seasons;
  assert.deepEqual(seasons.map(season => season.season_no), [4, 1]);
  assert.equal(listed(projects, a).season_id, one.id);
  assert.equal(series.list()[0].next_season_no, 5);
  assert.equal(series.list()[0].seasons[1].next_episode_no, 7);
});

test("creative backup round-trips directory, high-water marks and receipts; older backups preserve grouping", async t => {
  const { series, store, a } = await setup(t);
  const legacy = store.backup();
  assert.equal(Object.hasOwn(legacy, "project_series"), false);
  const drama = createDrama(series);
  const season = series.createSeason(drama.id, { request_id: randomUUID(), season_no: 3 });
  const moved = move(series, inSeason(season), [item(a, 7)]);
  await store.restore(legacy);
  assert.equal(series.membership(a.id).season_id, season.id);
  const backup = store.backup();
  const target = await setup(t);
  target.projects.remove(target.a.id);
  target.projects.remove(target.b.id);
  await target.store.restore(backup);
  assert.deepEqual(target.series.list(), series.list());
  assert.deepEqual(target.series.request(moved.request_id), series.request(moved.request_id));
  assert.deepEqual(target.series.membership(a.id), series.membership(a.id));
  target.series.undo(moved.request_id, { request_id: randomUUID() });
  assert.equal(target.series.membership(a.id).series_id, null);
  assert.equal(target.series.list()[0].seasons[0].next_episode_no, 8);
  await assert.rejects(target.store.restore(backup), { status: 409 });
  assert.equal(target.series.membership(a.id).series_id, null);

  const invalid = structuredClone(backup);
  invalid.project_series.project_series_members[0].season_id = randomUUID();
  const { format, schema_version, checksum, ...content } = invalid;
  invalid.checksum = digest(content);
  assert.throws(() => store.validateBackup(invalid), /备份剧集目录/);
});

test("HTTP series routes return the published contract and distinguish invalid input and stale requests", async t => {
  const { series, projects } = await setup(t);
  const app = express();
  app.use(express.json());
  app.use("/api", projectSeriesRouter(series));
  app.get("/api/projects", (_req, res) => res.json(projects.list()));
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port + "/api";
  async function call(route, method = "GET", body) {
    const response = await fetch(base + route, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  const created = await call("/project-series", "POST", { name: "接口剧名", request_id: randomUUID() });
  assert.equal(created.status, 200);
  const path = "/project-series/" + created.data.id;
  const input = { season_id: null, expected_episode_no: 1, request_id: randomUUID() };
  const result = await call(path + "/episodes", "POST", input);
  assert.equal(result.status, 200);
  assert.equal(result.data.project.membership_revision, 1);
  assert.equal((await call(path + "/episodes", "POST", [])).data.code, "INVALID_SERIES_INPUT");
  const stale = await call(path + "/episodes", "POST", { ...input, request_id: randomUUID() });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.data.details, { next_episode_no: 2 });
  const projectsResult = await call("/projects");
  assert.equal(listed({ list: () => projectsResult.data }, result.data.project).episode_no, 1);
  assert.deepEqual((await call("/project-series/requests/" + input.request_id)).data, { found: true, result: result.data });
});

test("the SQLite-to-MySQL mapping retains series keys and collision constraints", () => {
  assert.equal(Object.keys(SERIES_TABLES).length, 5);
  assert.equal(mysqlColumnType("project_series", { name: "name_key" }), "CHAR(64)");
  assert.equal(mysqlColumnType("project_series_members", { name: "container_key" }), "VARCHAR(36)");
  assert.equal(mysqlColumnType("project_series_members", { name: "episode_no" }), "BIGINT");
  assert.equal(mysqlColumnType("project_series_requests", { name: "result_json" }), "LONGTEXT");
  assert.deepEqual(seriesConstraints("project_series_members"), ["UNIQUE(series_id,container_key,episode_no)"]);
});
