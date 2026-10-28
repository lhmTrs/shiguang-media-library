import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { Library } from "../server/library.mjs";
import { keywordPredicate } from "../server/search-aliases.mjs";

// Memory-only queries: no scanning, file operations, desktop dialogs or live database.
test("search aliases, name-only scope, combinations and filename tie-break", t => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE assets (
    id INTEGER PRIMARY KEY, name TEXT, kind TEXT DEFAULT 'sfx', tags TEXT DEFAULT '[]',
    note TEXT DEFAULT '', category TEXT DEFAULT '', sub TEXT DEFAULT '',
    trashed INTEGER DEFAULT 0, reveal_count INTEGER DEFAULT 0,
    path TEXT DEFAULT '/fixtures/file', root_id TEXT DEFAULT 'test', ext TEXT DEFAULT 'wav',
    size INTEGER DEFAULT 0, mtime INTEGER DEFAULT 0, created_ms INTEGER, captured_ms INTEGER
  )`);
  const rows = [
    ["悬疑转场.wav", "sfx", "[]", "", ""],
    ["Dark_Whoosh.wav", "sfx", '["恐怖"]', "", ""],
    ["普通.wav", "sfx", '["转场"]', "恐怖", ""],
    ["White noise.wav", "sfx", "[]", "", ""],
    ["Heavy_hit.wav", "sfx", "[]", "", ""],
    ["Footsteps.wav", "sfx", "[]", "", ""],
    ["Whoosh song.wav", "music", "[]", "", ""],
    ["100%_test.wav", "sfx", "[]", "", ""],
    ["普通2.wav", "sfx", "[]", "", "悬疑转场"],
    ["Drone.wav", "sfx", "[]", "", ""],
    ["电影 转场.wav", "sfx", "[]", "", ""],
    ["电影 普通 转场.wav", "sfx", "[]", "", ""],
  ];
  const insert = db.prepare("INSERT INTO assets(name,kind,tags,note,category) VALUES(?,?,?,?,?)");
  for (const row of rows) insert.run(...row);
  const lib = Object.create(Library.prototype);
  Object.assign(lib, { db, activeAssetScope: () => "1=1", nonMissingAssetScope: () => "1=1", categoryOptions: () => [] });
  const names = query => lib.list(query).items.map(item => item.name);
  assert(names({ q: "转场", qField: "name" }).includes("Dark_Whoosh.wav"));
  assert(!names({ q: "转场", qField: "name" }).includes("Whoosh song.wav"));
  assert(names({ q: "whoosh", qField: "name" }).includes("悬疑转场.wav"));
  assert(names({ q: "whoosh", qField: "name" }).includes("Whoosh song.wav"));
  assert(names({ q: "转场" }).includes("普通.wav"));
  assert(names({ q: "转场" }).includes("普通2.wav"));
  assert(!names({ q: "转场", qField: "name" }).includes("普通.wav"));
  assert(!names({ q: "转场", qField: "name" }).includes("普通2.wav"));
  assert.deepEqual(names({ q: "hit", qField: "name" }), ["Heavy_hit.wav"]);
  assert.deepEqual(names({ q: "脚步", qField: "name" }), ["Footsteps.wav"]);
  assert.deepEqual(names({ q: "转场 恐怖", qField: "name" }), []);
  assert.deepEqual(new Set(names({ q: "转场 恐怖" })), new Set(["Dark_Whoosh.wav", "普通.wav"]));
  assert(names({ q: "脚步 恐怖", qMode: "any" }).includes("Footsteps.wav"));
  assert.equal(names({ q: '"电影 转场"' }).length, 1);
  assert.equal(names({ q: "100%_" }).length, 1);
  assert.equal(names({ q: "低沉" }).length, 0);
  const exact = lib.assetFilter({ q: "转场" }, false, { expandAliases: false });
  assert(!db.prepare("SELECT name FROM assets WHERE " + exact.where).all(...exact.values).some(row => row.name === "Dark_Whoosh.wav"));
  assert.throws(() => lib.list({ qField: "invalid" }), /搜索字段/);
  assert.throws(() => lib.list({ qMode: "invalid" }), /匹配方式/);
  db.prepare("UPDATE assets SET reveal_count=5 WHERE name='Heavy_hit.wav'").run();
  const sorted = names({ sort: "revealCount" });
  assert.equal(sorted[0], "Heavy_hit.wav");
  assert(sorted.indexOf("悬疑转场.wav") < sorted.indexOf("Dark_Whoosh.wav"));
  assert(sorted.indexOf("White noise.wav") < sorted.indexOf("Dark_Whoosh.wav"));
  db.exec("CREATE TABLE project_assets (asset_id INTEGER, project_id TEXT, status TEXT)");
  for (const sort of ["revealCount", "projectCount"]) {
    const results = names({ sort, q: "转场" });
    assert(results.indexOf("悬疑转场.wav") < results.indexOf("普通.wav"));
    assert(results.indexOf("Dark_Whoosh.wav") < results.indexOf("普通2.wav"), "name aliases outrank category matches at equal counts");
    assert.deepEqual(names({ sort, q: "转场 恐怖" }), ["普通.wav", "Dark_Whoosh.wav"], "all terms must match the name for the name tie-break");
    const any = names({ sort, q: "脚步 恐怖", qMode: "any" });
    assert(any.indexOf("Footsteps.wav") < any.indexOf("普通.wav"));
    assert.deepEqual(names({ sort, q: '"电影 转场"' }), ["电影 转场.wav"]);
  }
  db.prepare("UPDATE assets SET reveal_count=1 WHERE name='普通.wav'").run();
  assert.equal(names({ sort: "revealCount", q: "转场" })[0], "普通.wav", "count remains the primary order");
  db.exec("INSERT INTO project_assets SELECT id,'p1','used' FROM assets WHERE name='普通2.wav'");
  assert.equal(names({ sort: "projectCount", q: "转场" })[0], "普通2.wav", "project usage remains the primary order");
});

test("MySQL predicate uses parameterized native REGEXP, with a one-field name scope", () => {
  const result = keywordPredicate("转场", {kind: "mysql"}, {nameOnly: true});
  assert.match(result.sql, /REGEXP \?/);
  assert(!result.sql.includes("tags"));
  assert(!result.sql.includes("whoosh"));
  assert.equal(result.values.length, 2);
  assert.equal((result.sql.match(/\?/g) || []).length, result.values.length);
});
