import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { Library } from "../server/library.mjs";
import { FolderBrowser } from "../server/folder-browser.mjs";
import { directoryClass, classId, PENDING_DIRECTORY } from "../server/directory-classification.mjs";
import { reconcileRoot, reconcilePaths } from "../server/reconcile.mjs";

test("位置规则：两级封顶、根散文件和待确认别名、边界", () => {
  const root = { path: "/A" };
  assert.deepEqual(directoryClass(root, "/A/B/C/D/音乐.mp3"), { category: "B", sub: "C", review: 0 });
  assert.deepEqual(directoryClass(root, "/A/B/音乐.mp3"), { category: "B", sub: "", review: 0 });
  for (const file of ["/A/音乐.mp3", "/A/待确认/音乐.mp3", "/A/待试听确认/C/D/音乐.mp3"])
    assert.deepEqual(directoryClass(root, file), { category: "待确认", sub: "", review: 1 });
  assert.equal(directoryClass(root, "/AB/音乐.mp3"), null);
});

test("前端重名展示只加前缀，不修改数据或归属；唯一分类不加前缀", async () => {
  const source = await fs.readFile(new URL("../src/directory-labels.ts", import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
  const { displayDirectoryOptions } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
  const original = [{ id: "one", rootId: "a", rootName: "音乐", category: "悬疑", n: 1 }, { id: "two", rootId: "b", rootName: "音效", category: "悬疑", n: 2 }, { id: "three", rootId: "a", rootName: "音乐", category: "温馨", n: 3 }];
  assert.deepEqual(displayDirectoryOptions(original).map(c => c.category), ["音乐_悬疑", "音效_悬疑", "温馨"]);
  assert.equal(original[0].category, "悬疑");
  assert.equal(displayDirectoryOptions([original[0]], original)[0].id, "one");
});

test("首次扫描、根隔离、待确认移入移出与撤销、外部改名和旧清单不会覆盖", async t => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sg-directory-class-")));
  const lib = await new Library(path.join(dir, "data"), { directoryClassification: true }).init(); lib.enqueue = () => {};
  t.after(async () => { lib.db.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const roots = [];
  for (const name of ["音乐", "音效"]) {
    const folder = path.join(dir, name); await fs.mkdir(path.join(folder, "B", "C", "D"), { recursive: true });
    await fs.mkdir(path.join(folder, "待试听确认"));
    for (const file of ["根.wav", "B/一级.wav", "B/C/D/深层.wav", "待试听确认/待定.wav"]) await fs.writeFile(path.join(folder, file), file);
    const root = await lib.addRoot(folder, name === "音乐" ? "music" : "sfx"); roots.push(root);
    const job = lib.scan(root.id); while (job.status === "running") await new Promise(r => setTimeout(r, 10));
    assert.equal(job.status, "done");
  }
  assert.equal(lib.stats().review, 4);
  const first = roots[0];
  assert.equal(lib.list({ category: classId(first.id, "B") }).total, 2);
  const deep = lib.list({ category: classId(first.id, "B", "C") }).items;
  assert.equal(deep.length, 1); assert.equal(deep[0].sub, "C");
  assert.equal(lib.directoryClassification.options().filter(c => c.category === "B" && !c.sub).length, 2);
  const loose = lib.list({ root: first.id, view: "review" }).items.find(a => a.name === "根.wav");
  lib.patch(loose.id, { tags: ["保留"], note: "位置决定分类" });
  assert.throws(() => lib.patch(loose.id, { confirmed: true }), /移出/);
  assert.throws(() => lib.patch(loose.id, { category: "随便改" }), /位置决定/);
  const options = { hashBudgetFiles: 0, hashBudgetBytes: 0, tagFiles: false };
  await reconcileRoot(lib, first, options);
  const input = { action: "move", rootId: first.id, relative: "B/C/D", ids: [loose.id] };
  const moved = await lib.execute(input, await lib.plan(input)); assert.equal(moved[0].ok, true);
  assert.equal(lib.asset(loose.id).review, 0); assert.equal(lib.asset(loose.id).sub, "C");
  assert.equal(lib.list({ view: "review" }).total, 3);
  await lib.undo(moved[0].operation); assert.equal(lib.asset(loose.id).review, 1);
  await fs.rename(loose.path, path.join(first.path, "B", loose.name));
  await reconcilePaths(lib, first, [loose.name, "B/" + loose.name], options);
  assert.equal(lib.asset(loose.id).review, 0); assert.equal(lib.asset(loose.id).sub, "");
  await reconcileRoot(lib, first, { ...options, importMetadata: true });
  assert.equal(lib.asset(loose.id).category, "B"); assert.equal(lib.asset(loose.id).review, 0);
  assert.deepEqual(lib.asset(loose.id).tags, ["保留"]);
  const browser = new FolderBrowser(lib);
  const child = await browser.branch({ root: first.id, directory: "B/C", classification: "1" });
  assert.equal(child.children.length, 0); assert.equal(child.total, 1);
  const pending = await browser.branch({ root: first.id, directory: PENDING_DIRECTORY, classification: "1" });
  assert.equal(pending.total, 1);
  assert.ok((await browser.branch({ root: first.id, directory: "B/C" })).children.some(c => c.name === "D"));
  assert.equal(lib.db.prepare("SELECT name FROM sqlite_master WHERE name='music_categories'").get(), undefined);
});
