import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Library } from "../server/library.mjs";
import { searchTerms, joinSearchTerms } from "../server/search-query.mjs";

test("关键词拆分、完整词组、重复词、空格与未闭合引号", () => {
  assert.deepEqual(searchTerms('  悬疑  恐怖 悬疑 '), ["悬疑", "恐怖"]);
  assert.deepEqual(searchTerms('"电影 转场" “低沉 恐怖” Whoosh whoosh'), ["电影 转场", "低沉 恐怖", "Whoosh"]);
  assert.deepEqual(searchTerms('"电影 转场'), ["电影 转场"]);
  assert.deepEqual(searchTerms(' ""  '), []);
  const terms = ["电影 转场", "恐怖", "100%_", "C:\\素材"];
  assert.deepEqual(searchTerms(joinSearchTerms(terms)), terms);
});

test("跨字段 AND/OR、词组、通配符转义、分页与筛选组合", async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "sg-keyword-search-"));
  const lib = await new Library(path.join(base, "data"), { directoryClassification: true }).init();
  lib.enqueue = () => {};
  t.after(async () => { lib.db.close(); await fs.rm(base, {recursive:true,force:true}); });
  const source = path.join(base, "source"); await fs.mkdir(source);
  for (let i = 0; i < 63; i++) await fs.writeFile(path.join(source, `悬疑 ${i}.wav`), "fixture only");
  for (const name of ["电影 转场.wav", "电影 普通 转场.wav", "100%_音效.wav", "100xx音效.wav"]) await fs.writeFile(path.join(source, name), "fixture only");
  const root = await lib.addRoot(source, "sfx"), job = lib.scan(root.id);
  while (job.status === "running") await new Promise(r => setTimeout(r, 5));
  assert.equal(job.status, "done");
  const first = lib.list({q:"悬疑"}).items[0];
  lib.patch(first.id, {tags:["恐怖"],note:"保留备注"});
  const both = lib.list({q:"悬疑 恐怖",kind:"sfx"});
  assert.equal(both.total,1); assert.equal(both.items[0].id,first.id);
  const either = lib.list({q:"悬疑 恐怖",qMode:"any",kind:"sfx"});
  assert.equal(either.total,63); assert.equal(either.items.length,60);
  assert.equal(lib.list({q:"悬疑 恐怖",qMode:"any",page:2}).items.length,3);
  assert.equal(lib.list({q:'"电影 转场"'}).total,1);
  assert.equal(lib.list({q:"电影 转场"}).total,2);
  assert.equal(lib.list({q:"100%_"}).total,1);
  assert.equal(lib.list({q:"悬疑 恐怖",kind:"music",qMode:"any"}).total,0);
  assert.equal(lib.list({q:' "" '}).total,67);
  assert.throws(() => lib.list({q:"悬疑",qMode:"invalid"}), /匹配方式/);
  assert.throws(() => lib.list({q:Array.from({length:33},(_,i)=>String(i)).join(" ")}), /32/);
});
