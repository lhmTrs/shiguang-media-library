import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { ReadCache, cachedRead } from "../server/read-cache.mjs";

test("统计缓存：30秒有效、隔离返回值、容量上限、异常重试", t => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  let now = 0, reads = 0;
  const cache = new ReadCache(db, { now: () => now, max: 2 });
  const load = () => { reads++; return [{ n: reads }]; };
  cache.read("all", load)[0].n = 99;
  assert.equal(cache.read("all", load)[0].n, 1);
  assert.equal(reads, 1);
  now = 29999; cache.read("all", load); assert.equal(reads, 1);
  now = 30000; assert.equal(cache.read("all", load)[0].n, 2);
  cache.read("music", load); cache.read("sfx", load);
  assert.equal(cache.entries.size, 2);
  assert.equal(cache.entries.has("all"), false);
  assert.throws(() => cache.read("failed", () => { throw Error("offline"); }), /offline/);
  assert.equal(cache.read("failed", () => 42), 42);
});

test("写入立即失效：预编译语句、exec、事务提交/回滚与事务内读取", t => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  const cache = new ReadCache(db);
  db.exec("CREATE TABLE items (n INTEGER)");
  const insert = db.prepare("INSERT INTO items VALUES (?)");
  let reads = 0;
  const read = () => cache.read("count", () => { reads++; return db.prepare("SELECT COUNT(*) AS n FROM items").get().n; });
  assert.equal(read(), 0); assert.equal(read(), 0); assert.equal(reads, 1);
  insert.run(1); assert.equal(read(), 1);
  db.exec("INSERT INTO items VALUES (2)"); assert.equal(read(), 2);
  db.transaction(() => { insert.run(3); assert.equal(read(), 3); })();
  assert.equal(read(), 3);
  assert.throws(() => db.transaction(() => {
    insert.run(4); assert.equal(read(), 4); throw Error("rollback");
  }).immediate(), /rollback/);
  assert.equal(read(), 3);
  assert.equal(db.transaction(function () { return this.value; }).call({ value: 7 }), 7);
});

test("切换数据库不复用旧缓存", t => {
  const first = new Database(":memory:"), second = new Database(":memory:");
  t.after(() => { first.close(); second.close(); });
  assert.equal(cachedRead(first, "categories", () => 1), 1);
  assert.equal(cachedRead(second, "categories", () => 2), 2);
  assert.equal(cachedRead(first, "categories", () => 9), 1);
});
