import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Library } from "../server/library.mjs";
import { AssetCategories } from "../server/music-categories.mjs";

test("7000条统计与旧SQL一致、主/额外分类去重、按类型隔离、写入后缓存立即失效", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sg-count-cache-"));
  const lib = await new Library(dir).init();
  t.after(async () => { lib.db.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const manager = new AssetCategories(lib).init();
  const kinds = ["music", "sfx", "photo", "video"];
  const insert = lib.db.prepare("INSERT INTO assets(id,path,name,kind,category,online,trashed) VALUES (?,?,?,?,?,?,?)");
  const link = lib.db.prepare("INSERT INTO music_category_links VALUES (?,?,?)");
  lib.db.transaction(() => {
    for (let c = 0; c < 100; c++) lib.db.prepare("INSERT INTO music_categories(id,name) VALUES (?,?)").run(`c${c}`, `分类${c}`);
    for (let i = 0; i < 7000; i++) {
      insert.run(`a${i}`, path.join(dir, `fixture${i}.wav`), `fixture${i}`, kinds[i % 4], i % 9 ? `分类${i % 100}` : "", i % 10 ? 1 : 0, i % 17 ? 0 : 1);
      if (i % 3 === 0) link.run(`l${i}`, `a${i}`, `c${i % 100}`);
      if (i % 5 === 0) link.run(`extra${i}`, `a${i}`, `c${(i + 1) % 100}`);
    }
  })();
  let loads = 0;
  const counts = manager.counts.bind(manager);
  manager.counts = kind => { loads++; return counts(kind); };
  for (const kind of ["", ...kinds]) {
    const rows = manager.list(kind ? { kind } : {}).filter(c => c.id !== "uncategorized");
    const expected = lib.db.prepare(`SELECT c.id,c.name,COUNT(a.id) n,SUM(CASE WHEN a.online=0 THEN 1 ELSE 0 END) offline
      FROM music_categories c LEFT JOIN assets a ON (a.category=c.name OR EXISTS(SELECT 1 FROM music_category_links l WHERE l.asset_id=a.id AND l.category_id=c.id))${kind ? " AND a.kind=?" : ""} AND a.trashed=0
      GROUP BY c.id,c.name ORDER BY c.name`).all(...(kind ? [kind] : []));
    assert.deepEqual(rows, expected.map(c => ({ ...c, offline: Number(c.offline || 0) })));
  }
  assert.equal(loads, 5);
  const before = manager.list(); manager.list({ kind: "music" }); assert.equal(loads, 5);
  const n = before.find(c => c.id === "c0").n;
  insert.run("added", path.join(dir, "added.wav"), "added", "music", "分类0", 1, 0);
  assert.equal(manager.list().find(c => c.id === "c0").n, n + 1);
  assert.equal(loads, 6);
  lib.db.prepare("UPDATE assets SET trashed=1 WHERE id=?").run("added");
  assert.equal(manager.list().find(c => c.id === "c0").n, n);
  lib.db.prepare("UPDATE assets SET category='分类1' WHERE id=?").run("added");
  const renamed = manager.rename("c1", { name: "已更名" });
  assert.ok(manager.list().some(c => c.id === renamed.id && c.name === "已更名"));
  assert.throws(() => manager.list({ kind: "invalid" }), /素材类型无效/);
});
