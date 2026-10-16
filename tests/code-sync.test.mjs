import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gitState, assertStopped } from "../scripts/update-code.mjs";

const exec = promisify(execFile);
test("代码同步：缺少仓库、未提交/未跟踪文件及缺少上游均拒绝；隔离仓库可检查", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-git-"));
  const git = async args => exec("git", args, { cwd: temp });
  try {
    await assert.rejects(gitState(temp), /不是独立/);
    await git(["init", "-b", "main"]);
    await git(["config", "user.name", "Fixture"]);
    await git(["config", "user.email", "fixture@example.invalid"]);
    await fs.writeFile(path.join(temp, "example.txt"), "fixture");
    await assert.rejects(gitState(temp), /未跟踪/);
    await git(["add", "example.txt"]);
    await git(["commit", "-m", "fixture"]);
    await assert.rejects(gitState(temp), /上游/);
    await git(["branch", "upstream-fixture"]);
    await git(["branch", "--set-upstream-to=upstream-fixture"]);
    const state = await gitState(temp);
    assert.match(state.before, /^[0-9a-f]{40,64}$/);
    await fs.writeFile(path.join(temp, "example.txt"), "edited");
    await assert.rejects(gitState(temp), /未提交/);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test("代码同步：不停止进程，运行记录存在时拒绝更新；私有文件被 Git 忽略", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-sync-safety-"));
  const data = path.join(temp, "data");
  try {
    await assertStopped(temp, { MEDIA_DATA_DIR: data });
    await fs.mkdir(data);
    await fs.writeFile(path.join(data, "server.json"), JSON.stringify({ pid: process.pid }));
    await assert.rejects(assertStopped(temp, { MEDIA_DATA_DIR: data }), /仍在运行/);
    process.kill(process.pid, 0);
    await fs.copyFile(new URL("../.gitignore", import.meta.url), path.join(temp, ".gitignore"));
    await exec("git", ["init", "-b", "main"], { cwd: temp });
    const names = ["data/library.sqlite", ".env.local", "mysql-connection.json", "reports/report.html", ".runtime/server.log", "releases/share.zip", "node_modules/x", "dist/index.html"];
    for (const name of names) await exec("git", ["check-ignore", "--no-index", name], { cwd: temp });
    await assert.rejects(exec("git", ["check-ignore", "--no-index", ".env.example"], { cwd: temp }));
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
