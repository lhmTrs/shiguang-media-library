import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dataDirectory } from "../server/runtime.mjs";
import { collectFiles, shareFiles } from "../scripts/package.mjs";

test("分享模式：独立数据目录与显式环境优先，Mac 旧目录不变", () => {
  const project = path.join(os.tmpdir(), "portable-project"), home = path.join(os.tmpdir(), "fake-home");
  assert.equal(dataDirectory(project, {}, "darwin", home), path.join(home, "Library", "Application Support", "拾光素材库"));
  assert.equal(dataDirectory(project, { MEDIA_PORTABLE: "1" }, "darwin", home), path.join(project, "data"));
  const explicit = path.join(os.tmpdir(), "explicit-data");
  assert.equal(dataDirectory(project, { MEDIA_PORTABLE: "1", MEDIA_DATA_DIR: explicit }, "darwin", home), explicit);
  assert.equal(dataDirectory(project, {}, "linux", home), path.join(home, ".local", "share", "shiguang-media"));
  assert.equal(dataDirectory(project, { XDG_DATA_HOME: "/xdg" }, "linux", home), path.join("/xdg", "shiguang-media"));
  assert.equal(dataDirectory(project, { LOCALAPPDATA: "/windows-local" }, "win32", home), path.join("/windows-local", "ShiguangMedia"));
});
test("分享白名单：不包含私人配置、运行数据、机器专用 node_modules 与旧批处理工具", async t => {
  for (const excluded of ["data", "node_modules", ".runtime", "reports", "scripts/connect-mysql.mjs", "scripts/tag-transitions.mjs", "scripts/check-sfx-duplicates.mjs", "启动素材库.command"]) assert.ok(!shareFiles.includes(excluded));
  for (const required of ["server", "src", "tests", "dist", "START_HERE.md", "AI_HANDOFF.md", "AGENTS.md", "scripts/verify-package.mjs"]) assert.ok(shareFiles.includes(required));
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "sg-package-files-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(path.join(base, "src")); await fs.writeFile(path.join(base, "src", "app.tsx"), "fixture");
  await fs.mkdir(path.join(base, "data")); await fs.writeFile(path.join(base, "data", "mysql-connection.json"), "private fixture");
  assert.deepEqual(await collectFiles(base, "src"), [path.join("src", "app.tsx")]);
  try { await fs.symlink(path.join(base, "data"), path.join(base, "src", "linked-private")); }
  catch (e) { if (process.platform === "win32" && e.code === "EPERM") return; throw e; }
  await assert.rejects(collectFiles(base, "src"), /符号链接/);
});
