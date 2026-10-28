/**
 * MUSIC-LAUNCHER-DELIVERY-20261026 / A2：受限 launcher 构建/校验/安装的隔离测试。
 *
 * 只使用临时“伪项目树”和 /tmp，真实调用 /usr/bin/clang；不写真实仓库 releases/，
 * 不运行发行音频引擎/真实 ffprobe，不读真实素材，不联网，不启动服务。
 * 真实编译事实无法用 mock 替代；关键时序构造不出的项显式记 NOT_RUN。
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { __testInternals } from "../server/native/audio-executor-launcher-build.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.dirname(HERE);
const A1 = path.join(PROJECT, "server", "native", "audio-executor-launcher-build.mjs");
const LAUNCHER_C = path.join(PROJECT, "server", "native", "audio-executor-launcher.c");
const CLANG = "/usr/bin/clang";
const NODE = process.execPath;
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const STAGE_RE = /^\.stage-[0-9]+-[0-9a-f]{16}$/;
const TMP_RE = /^\.audio-executor-launcher\.tmp-[0-9]+-[0-9a-f]{16}$/;

let base;
const temps = [];

async function mkProject(label) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), `launcher-test-${label}-`));
  temps.push(tmp);
  const proj = path.join(tmp, "proj");
  await fsp.mkdir(path.join(proj, "server", "native"), { recursive: true });
  await fsp.mkdir(path.join(proj, "releases"), { recursive: true });
  const copy = path.join(proj, "server", "native", "audio-executor-launcher-build.mjs");
  await fsp.copyFile(A1, copy);
  assert.equal(sha256(await fsp.readFile(copy)), sha256(await fsp.readFile(A1)));
  return { tmp, proj, a1: copy };
}

function preserve(root) {
  // 故障现场（unknown 根/外来文件）不从全局 after 删除；只保留，不扫描历史根。
  const index = temps.indexOf(root);
  if (index >= 0) temps.splice(index, 1);
}

async function cleanup(root) {
  if (!root) return;
  const baseName = path.basename(root);
  if (!baseName.startsWith("launcher-test-") && !baseName.startsWith("launcher-evidence-")) {
    throw new Error(`拒绝清理非测试根: ${root}`);
  }
  await fsp.rm(root, { recursive: true, force: true });
  await assert.rejects(fsp.lstat(root), (error) => error.code === "ENOENT");
}

after(async () => {
  for (const root of temps.reverse()) await cleanup(root);
});

function parseJson(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const lines = trimmed.split("\n");
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

function runCli(proj, args, options = {}) {
  const nodeArgs = options.nodeArgs ?? [];
  const result = spawnSync(
    NODE,
    [...nodeArgs, path.join(proj, "server", "native", "audio-executor-launcher-build.mjs"), ...args],
    {
      cwd: proj,
      encoding: "utf8",
      timeout: options.timeout ?? 90_000,
      env: { ...process.env, ...(options.env ?? {}) },
    },
  );
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    json: parseJson(result.stdout) ?? parseJson(result.stderr),
  };
}

const FAULT_PRELOAD = `import fs from 'node:fs/promises';
import path from 'node:path';
const mode = process.env.REVIEW_FAULT;
const trace = process.env.REVIEW_TRACE;
const record = async (value) => fs.writeFile(trace, JSON.stringify(value));
if (mode === 'work-lstat') {
  const original = fs.lstat;
  fs.lstat = async function (p, ...args) {
    if (/^shiguang-launcher-build-/.test(path.basename(String(p)))) {
      await record({ workRoot: String(p) });
      throw Object.assign(new Error('synthetic unreadable own root'), { code: 'EACCES' });
    }
    return original.call(this, p, ...args);
  };
}
if (mode === 'foreign-tmp') {
  const original = fs.link;
  fs.link = async function (src, target) {
    if (path.basename(String(src)).startsWith('.audio-executor-launcher.tmp-')) {
      await fs.unlink(src);
      await fs.writeFile(src, 'FOREIGN_REPLACEMENT', { mode: 0o600 });
      await record({ foreignTmp: String(src) });
      throw Object.assign(new Error('synthetic publication denied'), { code: 'EACCES' });
    }
    return original.call(this, src, target);
  };
}
if (mode === 'partial-candidate') {
  const original = fs.link;
  fs.link = async function (src, target) {
    if (path.basename(String(target)) === 'SHA256SUMS') {
      const dir = path.dirname(String(target));
      await fs.unlink(path.join(dir, 'artifact.json'));
      await fs.writeFile(path.join(dir, 'artifact.json'), 'FOREIGN_METADATA');
      await record({ candidate: dir });
      throw Object.assign(new Error('synthetic third-member denied'), { code: 'EACCES' });
    }
    return original.call(this, src, target);
  };
}
`;

async function writeFaultPreload(root) {
  const file = path.join(root, "launcher-test-fault-preload.mjs");
  await fsp.writeFile(file, FAULT_PRELOAD);
  return file;
}

function runCliFault(project, args, fault, tracePath) {
  return runCli(project.proj, args, {
    nodeArgs: ["--import", pathToFileURL(path.join(project.tmp, "launcher-test-fault-preload.mjs")).href],
    env: { REVIEW_FAULT: fault, REVIEW_TRACE: tracePath },
  });
}

function runCliAsync(proj, args) {
  const child = spawn(NODE, [path.join(proj, "server", "native", "audio-executor-launcher-build.mjs"), ...args], {
    cwd: proj,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  return new Promise((resolve) => {
    child.once("close", (status, signal) => {
      resolve({ status, signal, stdout, stderr, json: parseJson(stdout) ?? parseJson(stderr) });
    });
  });
}

async function waitFor(predicate, timeoutMs = 5000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await delay(intervalMs);
  }
}

async function waitForStages(arm64, count = 1) {
  return waitFor(async () => {
    let entries;
    try {
      entries = await fsp.readdir(arm64);
    } catch {
      return null;
    }
    const stages = entries.filter((name) => STAGE_RE.test(name)).sort();
    if (stages.length < count) return null;
    const ready = [];
    for (const name of stages) {
      const dir = path.join(arm64, name);
      try {
        const members = (await fsp.readdir(dir)).sort();
        if (members.join(",") !== "SHA256SUMS,artifact.json,audio-executor-launcher") continue;
        const sizes = await Promise.all(
          members.map(async (member) => (await fsp.lstat(path.join(dir, member))).size),
        );
        if (sizes.some((size) => size <= 0)) continue;
        ready.push(dir);
      } catch {
        continue;
      }
    }
    return ready.length >= count ? ready : null;
  }, 20_000);
}

function lockOwner(pid = process.pid, action = "build") {
  return `${JSON.stringify({
    format: 1,
    pid,
    hostname: "test-host",
    startedAt: new Date().toISOString(),
    nonce: crypto.randomBytes(8).toString("hex"),
    action,
  })}\n`;
}

async function createTestLock(lockDir, owner = lockOwner()) {
  await fsp.mkdir(lockDir, { mode: 0o700 });
  await fsp.writeFile(path.join(lockDir, "owner.json"), owner, { mode: 0o600 });
}

async function releaseTestLock(lockDir) {
  await fsp.unlink(path.join(lockDir, "owner.json"));
  await fsp.rmdir(lockDir);
}

async function installDir(project) {
  const dir = path.join(project.proj, "releases", "launcher", "macos-arm64");
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function assertNoStale(project) {
  const found = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".stale-")) found.push(path.join(dir, entry.name));
      if (entry.isDirectory()) await walk(path.join(dir, entry.name));
    }
  }
  await walk(path.join(project.proj, "releases"));
  assert.deepEqual(found, []);
}

async function statFacts(target) {
  const stat = await fsp.lstat(target);
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: stat.mode & 0o777,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

async function copyCandidate(candidate, destination) {
  await fsp.cp(candidate, destination, { recursive: true, errorOnExist: true });
  return destination;
}

before(async () => {
  base = await mkProject("base");
  const result = runCli(base.proj, ["build", "--source", LAUNCHER_C]);
  assert.equal(result.status, 0, `base build failed: ${result.stderr}`);
  assert.equal(result.json.action, "build");
  base.sha = result.json.sha256;
  base.bytes = result.json.bytes;
  base.artifact = path.join(
    base.proj,
    "releases",
    "launcher-candidates",
    "macos-arm64",
    base.sha,
    "audio-executor-launcher",
  );
  base.candidate = path.dirname(base.artifact);
});

test("L01 正确产物全链：build/verify/真实运行", { timeout: 90_000 }, async () => {
  const verify = runCli(base.proj, ["verify", "--artifact", base.artifact, "--sha256", base.sha]);
  assert.equal(verify.status, 0, verify.stderr);
  assert.deepEqual(Object.keys(verify.json).sort(), [
    "action",
    "arch",
    "bytes",
    "ok",
    "path",
    "platform",
    "sha256",
  ]);
  assert.equal(verify.json.ok, true);
  assert.equal(verify.json.sha256, base.sha);
  assert.equal(verify.json.bytes, base.bytes);

  const members = (await fsp.readdir(base.candidate)).sort();
  assert.deepEqual(members, ["SHA256SUMS", "artifact.json", "audio-executor-launcher"]);
  assert.equal((await fsp.lstat(path.join(base.candidate, "audio-executor-launcher"))).mode & 0o777, 0o500);
  assert.equal((await fsp.lstat(path.join(base.candidate, "artifact.json"))).mode & 0o777, 0o400);
  assert.equal((await fsp.lstat(path.join(base.candidate, "SHA256SUMS"))).mode & 0o777, 0o400);
  const verified = await __testInternals.verifyCandidateAtPath(base.candidate, base.sha);
  assert.equal(verified.binarySha256, base.sha);
  assert.equal(verified.manifest.status, "candidate");

  const run = spawnSync(base.artifact, ["/bin/sh", "-c", "ulimit -t; ulimit -f; ulimit -n; umask"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.trim().split("\n");
  assert.equal(lines[0], "180");
  assert.ok(["65536", "131072"].includes(lines[1]), `FSIZE blocks=${lines[1]}`);
  assert.equal(lines[2], "256");
  assert.equal(lines[3], "0077");

  const pidChild = spawn(base.artifact, ["/bin/sh", "-c", "echo $$"], { stdio: ["ignore", "pipe", "ignore"] });
  let pidOut = "";
  pidChild.stdout.on("data", (chunk) => {
    pidOut += chunk.toString("utf8");
  });
  const pidStatus = await new Promise((resolve) => pidChild.once("close", resolve));
  assert.equal(pidStatus, 0);
  assert.equal(pidOut.trim(), String(pidChild.pid));
  assert.ok(!/READY|passed/.test(verify.stdout));
});

test("L02 同源重复发布：同 SHA 幂等或不同 SHA 并存", { timeout: 90_000 }, async () => {
  const second = runCli(base.proj, ["build", "--source", LAUNCHER_C]);
  assert.equal(second.status, 0, second.stderr);
  const arm64 = path.join(base.proj, "releases", "launcher-candidates", "macos-arm64");
  const candidates = (await fsp.readdir(arm64)).filter((name) => !name.startsWith("."));
  if (second.json.sha256 === base.sha) {
    assert.equal(second.json.changed, false);
    assert.equal(candidates.length, 1);
  } else {
    assert.equal(second.json.changed, true);
    assert.equal(candidates.length, 2);
    await __testInternals.verifyCandidateAtPath(path.join(arm64, second.json.sha256), second.json.sha256);
  }
  for (const name of candidates) {
    assert.doesNotMatch(name, /^\.stage-/);
  }
});

test("L03 平台/架构不符：x86_64 产物被 verify/install 拒绝", { timeout: 90_000 }, async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "launcher-test-x86-"));
  temps.push(tmp);
  const out = path.join(tmp, "x86-launcher");
  const compile = spawnSync(CLANG, ["-arch", "x86_64", "-O2", "-Wall", "-Wextra", "-o", out, LAUNCHER_C], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(compile.status, 0, compile.stderr);
  const x86Sha = sha256(await fsp.readFile(out));
  const verify = runCli(base.proj, ["verify", "--artifact", out, "--sha256", x86Sha]);
  assert.equal(verify.status, 3);
  assert.equal(verify.json.error, "VERIFY_FAILED");
  const project = await mkProject("l03");
  const dir = await installDir(project);
  const install = runCli(project.proj, ["install", "--artifact", out, "--sha256", x86Sha, "--dir", dir]);
  assert.equal(install.status, 3);
  await assert.rejects(fsp.lstat(path.join(dir, "audio-executor-launcher")), (error) => error.code === "ENOENT");
});

test("L04 源码篡改（编译前）→ SOURCE_MISMATCH，不写候选", { timeout: 90_000 }, async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "launcher-test-src-"));
  temps.push(tmp);
  const source = path.join(tmp, "launcher-bad.c");
  await fsp.writeFile(source, `${await fsp.readFile(LAUNCHER_C, "utf8")}\n`);
  const result = runCli(base.proj, ["build", "--source", source]);
  assert.equal(result.status, 5);
  assert.equal(result.json.error, "SOURCE_MISMATCH");
  const arm64 = path.join(base.proj, "releases", "launcher-candidates", "macos-arm64");
  const names = (await fsp.readdir(arm64)).filter((name) => name.startsWith(".stage-"));
  assert.deepEqual(names, []);
  await assertNoStale(base);
});

test("L05 二进制篡改 → verify/install 拒绝", { timeout: 90_000 }, async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "launcher-test-bin-"));
  temps.push(tmp);
  const tampered = path.join(tmp, "tampered-launcher");
  const bytes = Buffer.from(await fsp.readFile(base.artifact));
  bytes[Math.floor(bytes.length / 2)] ^= 0x01;
  await fsp.writeFile(tampered, bytes, { mode: 0o500 });
  const tamperedSha = sha256(bytes);
  const verify = runCli(base.proj, ["verify", "--artifact", tampered, "--sha256", base.sha]);
  assert.equal(verify.status, 3);
  const verifyOwn = runCli(base.proj, ["verify", "--artifact", tampered, "--sha256", tamperedSha]);
  assert.equal(verifyOwn.status, 0, "翻转后按新 SHA 是另一个完整字节身份，不是篡改旧身份");
  const project = await mkProject("l05");
  const dir = await installDir(project);
  const install = runCli(project.proj, ["install", "--artifact", tampered, "--sha256", base.sha, "--dir", dir]);
  assert.equal(install.status, 3);
  await assert.rejects(fsp.lstat(path.join(dir, "audio-executor-launcher")), (error) => error.code === "ENOENT");
});

test("L06 符号链接逐级拒绝", { timeout: 90_000 }, async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "launcher-test-links-"));
  temps.push(tmp);
  const proj = await mkProject("links");
  const sourceLink = path.join(tmp, "source-link.c");
  await fsp.symlink(LAUNCHER_C, sourceLink);
  const sourceResult = runCli(proj.proj, ["build", "--source", sourceLink]);
  assert.equal(sourceResult.status, 7);

  const realOut = path.join(tmp, "real-out");
  await fsp.mkdir(realOut);
  const outLink = path.join(tmp, "out-link");
  await fsp.symlink(realOut, outLink);
  const outResult = runCli(proj.proj, ["build", "--source", LAUNCHER_C, "--out-root", outLink]);
  assert.equal(outResult.status, 7);

  const outRoot = path.join(proj.proj, "releases", "launcher-candidates");
  await fsp.mkdir(outRoot, { recursive: true });
  const outside = path.join(tmp, "outside-arm64");
  await fsp.mkdir(outside);
  await fsp.symlink(outside, path.join(outRoot, "macos-arm64"));
  const armResult = runCli(proj.proj, ["build", "--source", LAUNCHER_C]);
  assert.equal(armResult.status, 7);

  const fakeCandidate = path.join(tmp, "fake-candidate");
  await copyCandidate(base.candidate, fakeCandidate);
  const realBinary = path.join(tmp, "real-binary");
  await fsp.rename(path.join(fakeCandidate, "audio-executor-launcher"), realBinary);
  await fsp.symlink(realBinary, path.join(fakeCandidate, "audio-executor-launcher"));
  await assert.rejects(
    __testInternals.verifyCandidateAtPath(fakeCandidate, base.sha),
    (error) => error.code === "PATH_UNSAFE",
  );

  const dir = await installDir(proj);
  await fsp.rm(dir, { recursive: true, force: true });
  const outsideDir = path.join(tmp, "outside-install");
  await fsp.mkdir(outsideDir);
  await fsp.symlink(outsideDir, dir);
  const install = runCli(proj.proj, ["install", "--artifact", base.artifact, "--sha256", base.sha, "--dir", dir]);
  assert.equal(install.status, 7);

  const inner = await mkProject("l06b");
  const realDir = path.join(inner.proj, "releases", "launcher", "real-macos-arm64");
  await fsp.mkdir(realDir, { recursive: true });
  const innerLink = path.join(inner.proj, "releases", "launcher", "macos-arm64");
  await fsp.symlink(realDir, innerLink);
  const innerInstall = runCli(inner.proj, [
    "install",
    "--artifact",
    base.artifact,
    "--sha256",
    base.sha,
    "--dir",
    innerLink,
  ]);
  assert.equal(innerInstall.status, 7, "指向 launcher 根内的符号链接也必须拒绝");

  const symProject = await mkProject("l06c");
  const symArm = path.join(symProject.proj, "releases", "launcher-candidates", "macos-arm64");
  await fsp.mkdir(symArm, { recursive: true });
  const symLock = path.join(symArm, ".shiguang-launcher-publish.lock");
  await createTestLock(symLock);
  const symBuild = runCliAsync(symProject.proj, ["build", "--source", LAUNCHER_C]);
  const symStages = await waitForStages(symArm, 1);
  assert.ok(symStages, "未观察到完整 stage");
  const stageSha = sha256(await fsp.readFile(path.join(symStages[0], "audio-executor-launcher")));
  const targetOutside = path.join(symProject.tmp, "target-outside");
  await fsp.mkdir(targetOutside);
  const targetLink = path.join(symArm, stageSha);
  await fsp.symlink(targetOutside, targetLink);
  await releaseTestLock(symLock);
  const symResult = await symBuild;
  assert.equal(symResult.status, 7, "候选 <sha> 目录为符号链接时必须 PATH_UNSAFE");
  assert.equal(await fsp.readlink(targetLink), targetOutside);
  assert.deepEqual((await fsp.readdir(symArm)).filter((name) => STAGE_RE.test(name)), []);
});

test("L07 既有安装目标不同 → 6 且字节/权限/mtime 不变", { timeout: 90_000 }, async () => {
  const project = await mkProject("l07");
  const dir = await installDir(project);
  const target = path.join(dir, "audio-executor-launcher");
  await fsp.writeFile(target, "different-launcher-bytes", { mode: 0o500 });
  const before = await statFacts(target);
  const result = runCli(project.proj, ["install", "--artifact", base.artifact, "--sha256", base.sha, "--dir", dir]);
  assert.equal(result.status, 6);
  assert.equal(result.json.error, "TARGET_EXISTS");
  const after = await statFacts(target);
  assert.deepEqual(after, before);
  assert.equal(await fsp.readFile(target, "utf8"), "different-launcher-bytes");
  const leftovers = (await fsp.readdir(dir)).filter((name) => TMP_RE.test(name));
  assert.deepEqual(leftovers, []);
});

test("L08 相对/越界路径拒绝", { timeout: 90_000 }, async () => {
  const relativeOut = runCli(base.proj, ["build", "--source", LAUNCHER_C, "--out-root", "relative"]);
  assert.equal(relativeOut.status, 2);
  const relativeSource = runCli(base.proj, ["build", "--source", "server/native/audio-executor-launcher.c"]);
  assert.equal(relativeSource.status, 2);
  const outside = runCli(base.proj, [
    "install",
    "--artifact",
    base.artifact,
    "--sha256",
    base.sha,
    "--dir",
    path.join(base.proj, "..", "outside"),
  ]);
  assert.equal(outside.status, 7);
  const tmpOutside = runCli(base.proj, [
    "install",
    "--artifact",
    base.artifact,
    "--sha256",
    base.sha,
    "--dir",
    "/tmp/launcher-not-a-project-dir",
  ]);
  assert.equal(tmpOutside.status, 7);
});

test("L08② 非法显式 install 目录：不创建默认 releases/launcher", { timeout: 90_000 }, async () => {
  const project = await mkProject("l08b");
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "launcher-test-outside-"));
  temps.push(outside);
  const result = runCli(project.proj, [
    "install",
    "--artifact",
    base.artifact,
    "--sha256",
    base.sha,
    "--dir",
    outside,
  ]);
  assert.equal(result.status, 7);
  assert.equal(result.json.error, "PATH_UNSAFE");
  assert.equal(
    fs.existsSync(path.join(project.proj, "releases", "launcher")),
    false,
    "拒绝显式越界路径时不得先创建默认 releases/launcher",
  );
});

test("L09 幂等安装：默认目录创建 + 第二次 changed=false 且不 touch", { timeout: 90_000 }, async () => {
  const project = await mkProject("l09");
  const dir = path.join(project.proj, "releases", "launcher", "macos-arm64");
  const first = runCli(project.proj, ["install", "--artifact", base.artifact, "--sha256", base.sha]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.json.changed, true);
  assert.equal((await fsp.lstat(dir)).isDirectory(), true);
  const target = path.join(dir, "audio-executor-launcher");
  const before = await statFacts(target);
  await delay(20);
  const second = runCli(project.proj, ["install", "--artifact", base.artifact, "--sha256", base.sha, "--dir", dir]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.json.changed, false);
  assert.deepEqual(await statFacts(target), before);
  assert.equal(second.json.runtimeConfig.launcher.sha256, base.sha);
});

test("L10 预建残缺候选 + stage 残留：锁内重验后 6", { timeout: 90_000 }, async () => {
  const project = await mkProject("l10");
  const arm64 = path.join(project.proj, "releases", "launcher-candidates", "macos-arm64");
  await fsp.mkdir(arm64, { recursive: true });
  const lockDir = path.join(arm64, ".shiguang-launcher-publish.lock");
  await createTestLock(lockDir);
  await fsp.mkdir(path.join(arm64, ".stage-old"));
  const child = runCliAsync(project.proj, ["build", "--source", LAUNCHER_C]);
  const stages = await waitForStages(arm64, 1);
  assert.ok(stages, "未观察到完整 stage");
  const stage = stages[0];
  const stageSha = sha256(await fsp.readFile(path.join(stage, "audio-executor-launcher")));
  const target = path.join(arm64, stageSha);
  await fsp.mkdir(target);
  await releaseTestLock(lockDir);
  const result = await child;
  assert.equal(result.status, 6, result.stderr);
  assert.equal(result.json.error, "TARGET_EXISTS");
  assert.deepEqual(await fsp.readdir(target), []);
  assert.ok(fs.existsSync(path.join(arm64, ".stage-old")));
  assert.ok(
    result.json.inventory.some(
      (item) => item.kind === "stage-residue" && item.path.endsWith(".stage-old") && item.state === "preserved",
    ),
    "预先存在的 .stage-* 应只列 inventory、不删除",
  );
  const stageNames = (await fsp.readdir(arm64)).filter((name) => STAGE_RE.test(name));
  assert.deepEqual(stageNames, []);
  await assertNoStale(project);
});

test("L10② 候选第三成员失败：先核全量再回滚，外来元数据保留", { timeout: 90_000 }, async () => {
  const project = await mkProject("l10b");
  const partialOut = await fsp.mkdtemp(path.join(os.tmpdir(), "launcher-test-partial-"));
  temps.push(partialOut);
  preserve(partialOut);
  await writeFaultPreload(project.tmp);
  const trace = path.join(project.tmp, "trace-partial.json");
  const result = runCliFault(
    project,
    ["build", "--source", LAUNCHER_C, "--out-root", partialOut],
    "partial-candidate",
    trace,
  );
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.json.error, "INTERNAL");
  assert.equal(result.json.cleanup, "unknown");
  const { candidate } = JSON.parse(await fsp.readFile(trace, "utf8"));
  assert.equal(
    await fsp.readFile(path.join(candidate, "artifact.json"), "utf8"),
    "FOREIGN_METADATA",
    "外来元数据不得被回滚删除",
  );
  assert.ok(
    fs.existsSync(path.join(candidate, "audio-executor-launcher")),
    "任一成员身份不符时不得删除已链接的第一成员",
  );
  assert.ok(
    result.json.inventory.some((item) => item.kind === "target" && item.state === "unknown"),
    "target 必须列入 inventory 保留",
  );
  assert.ok(
    result.json.inventory.some((item) => item.kind === "stage" && item.state === "unknown"),
    "stage 必须列入 inventory 保留",
  );
  assert.ok(fs.existsSync(candidate), "候选目录必须保留供独立复核");
});

test("L11 结算纯函数与超时已结算：unknown 不冒充 done", { timeout: 90_000 }, async () => {
  for (let mask = 0; mask < 8; mask += 1) {
    const exited = Boolean(mask & 1);
    const groupSettled = Boolean(mask & 2);
    const streamsClosed = Boolean(mask & 4);
    const result = __testInternals.classifySettlement(exited, groupSettled, streamsClosed);
    if (exited && groupSettled && streamsClosed) {
      assert.equal(result.cleanup, "done");
      assert.deepEqual(result.missing, []);
    } else {
      assert.equal(result.cleanup, "unknown");
      assert.ok(result.missing.length > 0);
    }
  }
  const timeout = await __testInternals.runBoundedChild(
    "/bin/sh",
    ["-c", "sleep 30"],
    { timeoutMs: 300, maxStdoutBytes: 1024, maxStderrBytes: 1024 },
  );
  assert.equal(timeout.timedOut, true);
  assert.equal(timeout.exited, true);
  assert.equal(timeout.groupSettled, true);
  assert.equal(timeout.streamsClosed, true);
  assert.equal(timeout.cleanup, "done");
});

test("L11② 工作根 lstat EACCES：unknown 保根，不谎报 removed", { timeout: 90_000 }, async () => {
  const project = await mkProject("l11b");
  await writeFaultPreload(project.tmp);
  const trace = path.join(project.tmp, "trace-work-lstat.json");
  const result = runCliFault(project, ["build", "--source", LAUNCHER_C], "work-lstat", trace);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.action, "build");
  assert.equal(result.json.cleanup, "unknown");
  assert.ok(
    result.json.inventory.some((item) => item.kind === "tmp" && item.state === "unknown"),
    "工作根观察失败必须列入 inventory",
  );
  const { workRoot } = JSON.parse(await fsp.readFile(trace, "utf8"));
  assert.ok(fs.existsSync(workRoot), `unknown 工作根必须保留: ${workRoot}`);
  assert.equal((await fsp.lstat(path.join(workRoot, "source.c"))).isFile(), true);
});

test("L14 源码快照身份：读入副本后替换原文件无效", { timeout: 90_000 }, async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "launcher-test-snap-"));
  temps.push(tmp);
  const source = path.join(tmp, "source-copy.c");
  await fsp.copyFile(LAUNCHER_C, source);
  const snapshot = await __testInternals.readSourceSnapshot(source);
  assert.equal(snapshot.sha256, sha256(snapshot.buffer));
  await fsp.writeFile(source, `${await fsp.readFile(source, "utf8")}\n`);
  assert.equal(sha256(snapshot.buffer), sha256(await fsp.readFile(LAUNCHER_C)));
  const replay = path.join(tmp, "replay.c");
  await fsp.writeFile(replay, snapshot.buffer);
  assert.equal(sha256(await fsp.readFile(replay)), snapshot.sha256);

  const dirSource = path.join(tmp, "source-dir");
  await fsp.mkdir(dirSource);
  await assert.rejects(__testInternals.readSourceSnapshot(dirSource), (error) => error.code === "PATH_UNSAFE");
  const fifo = path.join(tmp, "source-fifo");
  spawnSync("mkfifo", [fifo]);
  if (fs.existsSync(fifo)) {
    await assert.rejects(__testInternals.readSourceSnapshot(fifo), (error) => error.code === "PATH_UNSAFE");
  }

  const project = await mkProject("l14");
  const arm64 = path.join(project.proj, "releases", "launcher-candidates", "macos-arm64");
  await fsp.mkdir(arm64, { recursive: true });
  const editable = path.join(project.proj, "editable.c");
  await fsp.copyFile(LAUNCHER_C, editable);
  const lockDir = path.join(arm64, ".shiguang-launcher-publish.lock");
  await createTestLock(lockDir);
  const child = runCliAsync(project.proj, ["build", "--source", editable]);
  const stages = await waitForStages(arm64, 1);
  assert.ok(stages, "未观察到完整 stage");
  await fsp.writeFile(editable, `${await fsp.readFile(editable, "utf8")}\n`);
  await releaseTestLock(lockDir);
  const result = await child;
  assert.equal(result.status, 0, result.stderr);
  const candidate = path.join(arm64, result.json.sha256);
  const artifact = JSON.parse(await fsp.readFile(path.join(candidate, "artifact.json"), "utf8"));
  assert.equal(artifact.source.sha256, sha256(await fsp.readFile(LAUNCHER_C)));
  assert.equal(artifact.source.bytes, 2430);
});

test("L15 同目标并发 install：恰一个 changed=true", { timeout: 90_000 }, async () => {
  const project = await mkProject("l15");
  const dir = await installDir(project);
  const lockDir = path.join(dir, ".shiguang-launcher-publish.lock");
  await createTestLock(lockDir, lockOwner(process.pid, "install"));
  const one = runCliAsync(project.proj, ["install", "--artifact", base.artifact, "--sha256", base.sha, "--dir", dir]);
  const two = runCliAsync(project.proj, ["install", "--artifact", base.artifact, "--sha256", base.sha, "--dir", dir]);
  await delay(250);
  await releaseTestLock(lockDir);
  const [first, second] = await Promise.all([one, two]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const changed = [first.json.changed, second.json.changed].filter(Boolean);
  assert.equal(changed.length, 1);
  const target = path.join(dir, "audio-executor-launcher");
  assert.equal(sha256(await fsp.readFile(target)), base.sha);
  assert.equal((await fsp.lstat(target)).mode & 0o777, 0o500);
  assert.deepEqual((await fsp.readdir(dir)).filter((name) => TMP_RE.test(name)), []);
});

test("L16 不同产物并发 build：各自完整或幂等，无半成品", { timeout: 90_000 }, async () => {
  const project = await mkProject("l16");
  const arm64 = path.join(project.proj, "releases", "launcher-candidates", "macos-arm64");
  await fsp.mkdir(arm64, { recursive: true });
  const lockDir = path.join(arm64, ".shiguang-launcher-publish.lock");
  await createTestLock(lockDir);
  const one = runCliAsync(project.proj, ["build", "--source", LAUNCHER_C]);
  const two = runCliAsync(project.proj, ["build", "--source", LAUNCHER_C]);
  const stages = await waitForStages(arm64, 2);
  assert.ok(stages, "未观察到两个完整 stage");
  await releaseTestLock(lockDir);
  const [first, second] = await Promise.all([one, two]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const candidates = (await fsp.readdir(arm64)).filter((name) => !name.startsWith("."));
  assert.ok(candidates.length === 1 || candidates.length === 2);
  for (const name of candidates) {
    await __testInternals.verifyCandidateAtPath(path.join(arm64, name), name);
  }
  assert.deepEqual((await fsp.readdir(arm64)).filter((name) => STAGE_RE.test(name)), []);
});

test("L17 非合作写者与文件级排他", { timeout: 90_000 }, async () => {
  const project = await mkProject("l17");
  const dir = await installDir(project);
  const target = path.join(dir, "audio-executor-launcher");
  const lockDir = path.join(dir, ".shiguang-launcher-publish.lock");
  await createTestLock(lockDir, lockOwner(process.pid, "install"));
  const child = runCliAsync(project.proj, ["install", "--artifact", base.artifact, "--sha256", base.sha, "--dir", dir]);
  await delay(300);
  await fsp.writeFile(target, "non-cooperating-writer", { mode: 0o500 });
  const intruder = await statFacts(target);
  await releaseTestLock(lockDir);
  const result = await child;
  assert.equal(result.status, 6, result.stderr);
  assert.equal(await fsp.readFile(target, "utf8"), "non-cooperating-writer");
  assert.deepEqual(await statFacts(target), intruder);

  const tmp = path.join(dir, ".audio-executor-launcher.tmp-1-0123456789abcdef");
  const target2 = path.join(dir, "exclusive-target");
  await fsp.writeFile(tmp, "first-bytes", { mode: 0o500 });
  const first = await __testInternals.publishFileExclusive(tmp, target2);
  assert.equal(first.created, true);
  const second = await __testInternals.publishFileExclusive(tmp, target2);
  assert.equal(second.created, false);
  assert.equal(second.code, "EEXIST");
  assert.equal(await fsp.readFile(target2, "utf8"), "first-bytes");
});

test("L17② install tmp 被外来替换：不删外来文件，unknown 保路径", { timeout: 90_000 }, async () => {
  const project = await mkProject("l17b");
  preserve(project.tmp);
  const dir = await installDir(project);
  await writeFaultPreload(project.tmp);
  const trace = path.join(project.tmp, "trace-foreign-tmp.json");
  const result = runCliFault(
    project,
    ["install", "--artifact", base.artifact, "--sha256", base.sha, "--dir", dir],
    "foreign-tmp",
    trace,
  );
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.json.error, "INTERNAL");
  assert.equal(result.json.cleanup, "unknown");
  const { foreignTmp } = JSON.parse(await fsp.readFile(trace, "utf8"));
  assert.equal(await fsp.readFile(foreignTmp, "utf8"), "FOREIGN_REPLACEMENT");
  assert.ok(
    result.json.inventory.some((item) => item.kind === "tmp" && item.path === foreignTmp && item.state === "unknown"),
    "外来替换的 tmp 路径必须列入 inventory 保留",
  );
  await assert.rejects(fsp.lstat(path.join(dir, "audio-executor-launcher")), (error) => error.code === "ENOENT");
});

test("L18 既有目标权限不变；verify 只读", { timeout: 90_000 }, async () => {
  const project = await mkProject("l18");
  const dir = await installDir(project);
  const target = path.join(dir, "audio-executor-launcher");
  await fsp.writeFile(target, await fsp.readFile(base.artifact, { encoding: null }), { mode: 0o644 });
  const s1 = await statFacts(target);
  const sameSha = runCli(project.proj, ["install", "--artifact", base.artifact, "--sha256", base.sha, "--dir", dir]);
  assert.equal(sameSha.status, 6);
  assert.deepEqual(await statFacts(target), s1);

  await fsp.writeFile(target, "different", { mode: 0o500 });
  const s2 = await statFacts(target);
  const different = runCli(project.proj, ["install", "--artifact", base.artifact, "--sha256", base.sha, "--dir", dir]);
  assert.equal(different.status, 6);
  assert.deepEqual(await statFacts(target), s2);

  const before = await statFacts(base.artifact);
  const verify = runCli(project.proj, ["verify", "--artifact", base.artifact, "--sha256", base.sha]);
  assert.equal(verify.status, 0, verify.stderr);
  assert.deepEqual(await statFacts(base.artifact), before);
});

test("L19 SHA256SUMS 路径注入与额外条目拒绝", { timeout: 90_000 }, async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "launcher-test-sums-"));
  temps.push(tmp);
  const variants = [
    `${base.sha}  ./audio-executor-launcher\n${base.sha}  artifact.json\n`,
    `${base.sha}  /tmp/audio-executor-launcher\n${base.sha}  artifact.json\n`,
    `${base.sha}  ../audio-executor-launcher\n${base.sha}  artifact.json\n`,
    `${base.sha}  audio-executor-launcher\n${base.sha}  audio-executor-launcher\n`,
    `${base.sha}  audio-executor-launcher\n${base.sha}  unknown\n`,
    `${base.sha}  audio-executor-launcher\n${base.sha}  artifact.json\nextra\n`,
    `${base.sha}  audio-executor-launcher\r\n${base.sha}  artifact.json\r\n`,
  ];
  for (const variant of variants) {
    assert.throws(() => __testInternals.parseSha256Sums(Buffer.from(variant)), (error) => error.code === "VERIFY_FAILED");
  }
  assert.throws(
    () => __testInternals.parseSha256Sums(Buffer.alloc(600, 0x61)),
    (error) => error.code === "VERIFY_FAILED",
  );

  const candidate = path.join(tmp, "candidate-with-extra");
  await copyCandidate(base.candidate, candidate);
  await fsp.writeFile(path.join(candidate, ".DS_Store"), "x");
  await assert.rejects(
    __testInternals.verifyCandidateAtPath(candidate, base.sha),
    (error) => error.code === "VERIFY_FAILED",
  );

  await fsp.unlink(path.join(candidate, ".DS_Store"));
  const sumsPath = path.join(candidate, "SHA256SUMS");
  await fsp.chmod(sumsPath, 0o600);
  await fsp.writeFile(sumsPath, variants[0]);
  await assert.rejects(
    __testInternals.verifyCandidateAtPath(candidate, base.sha),
    (error) => error.code === "VERIFY_FAILED",
  );
});

test("L20 子进程生命周期：TERM→KILL、驱动先退、快退出、超输出、spawn 失败", { timeout: 120_000 }, async () => {
  const a = await __testInternals.runBoundedChild(
    "/bin/sh",
    ["-c", "trap '' TERM; while :; do sleep 1; done"],
    { timeoutMs: 300, maxStdoutBytes: 1024, maxStderrBytes: 1024 },
  );
  assert.equal(a.timedOut, true);
  assert.equal(a.termSent, true);
  assert.equal(a.groupAliveAfterTerm, true);
  assert.equal(a.killSent, true);
  assert.equal(a.exited, true);
  assert.equal(a.groupSettled, true);
  assert.equal(a.streamsClosed, true);
  assert.equal(a.cleanup, "done");
  assert.ok(a.settleMs <= 9000, `settleMs=${a.settleMs}`);

  const b = await __testInternals.runBoundedChild(
    "/bin/sh",
    [
      "-c",
      'sh -c \'trap "" TERM; while :; do sleep 1; done\' & c=$!; trap \'exit 0\' TERM; wait $c',
    ],
    { timeoutMs: 300, maxStdoutBytes: 1024, maxStderrBytes: 1024 },
  );
  assert.equal(b.timedOut, true);
  assert.equal(b.exited, true);
  assert.equal(b.groupSettled, true);
  assert.equal(b.streamsClosed, true);
  assert.equal(b.groupAliveAfterTerm, true);
  assert.equal(b.killSent, true);
  assert.ok(b.exitAt !== null && b.killAt !== null);
  assert.ok(b.exitAt < b.killAt, `exitAt=${b.exitAt} killAt=${b.killAt}`);
  assert.ok(b.settleMs <= 9000, `settleMs=${b.settleMs}`);

  const c = await __testInternals.runBoundedChild("/bin/sh", ["-c", "sleep 30 & wait"], {
    timeoutMs: 300,
    maxStdoutBytes: 1024,
    maxStderrBytes: 1024,
  });
  assert.equal(c.groupSettled, true);
  assert.equal(c.streamsClosed, true);
  assert.equal(c.cleanup, "done");

  const d = await __testInternals.runBoundedChild("/bin/sh", ["-c", "yes x"], {
    timeoutMs: 5000,
    maxStdoutBytes: 1024,
    maxStderrBytes: 1024,
  });
  assert.equal(d.outputOverflow, true);
  assert.ok(d.stdoutBytes <= 1024 + 65536);
  assert.equal(d.groupSettled, true);
  assert.equal(d.streamsClosed, true);

  const e0 = await __testInternals.runBoundedChild("/bin/sh", ["-c", "exit 0"], { timeoutMs: 2000 });
  assert.equal(e0.status, 0);
  assert.equal(e0.exited, true);
  assert.equal(e0.groupSettled, true);
  assert.equal(e0.streamsClosed, true);
  assert.equal(e0.cleanup, "done");
  const e7 = await __testInternals.runBoundedChild("/bin/sh", ["-c", "exit 7"], { timeoutMs: 2000 });
  assert.equal(e7.status, 7);
  assert.equal(e7.exited, true);
  assert.equal(e7.streamsClosed, true);
  assert.equal(e7.cleanup, "done");

  const g = await __testInternals.runBoundedChild("/definitely-missing-launcher-test", [], {
    timeoutMs: 1000,
    maxStdoutBytes: 1024,
    maxStderrBytes: 1024,
  });
  assert.equal(g.spawnError.code, "ENOENT");
  assert.equal(g.exited, false);
  assert.equal(g.cleanup, "unknown");
  // L20-h（setsid 逃逸）macOS 无标准 setsid，按矩阵只记边界，不纳入自动用例。
});

test("L21 锁残留：live/dead/missing/malformed 一律 8 且原样保留", { timeout: 120_000 }, async () => {
  const project = await mkProject("l21a");
  const arm64 = path.join(project.proj, "releases", "launcher-candidates", "macos-arm64");
  await fsp.mkdir(arm64, { recursive: true });
  const lockDir = path.join(arm64, ".shiguang-launcher-publish.lock");
  await createTestLock(lockDir, lockOwner(process.pid));
  const lockBefore = await statFacts(lockDir);
  const ownerPath = path.join(lockDir, "owner.json");
  const ownerBefore = await statFacts(ownerPath);
  const ownerBytes = await fsp.readFile(ownerPath);
  const live = runCli(project.proj, ["build", "--source", LAUNCHER_C]);
  assert.equal(live.status, 8);
  assert.equal(live.json.error, "PUBLISH_BUSY");
  assert.equal(live.json.details.ownerState, "live");
  assert.ok(live.json.details.waitedMs >= 7800);
  assert.deepEqual(await statFacts(lockDir), lockBefore);
  assert.deepEqual(await statFacts(ownerPath), ownerBefore);
  assert.deepEqual(await fsp.readFile(ownerPath), ownerBytes);
  assert.deepEqual((await fsp.readdir(arm64)).filter((name) => !name.startsWith(".")), []);
  await releaseTestLock(lockDir);

  const deadProject = await mkProject("l21b");
  const deadArm = path.join(deadProject.proj, "releases", "launcher-candidates", "macos-arm64");
  await fsp.mkdir(deadArm, { recursive: true });
  const deadLock = path.join(deadArm, ".shiguang-launcher-publish.lock");
  await createTestLock(deadLock, lockOwner(999999));
  const old = new Date(Date.now() - 60_000);
  await fsp.utimes(path.join(deadLock, "owner.json"), old, old);
  const deadBefore = await statFacts(deadLock);
  const dead = runCli(deadProject.proj, ["build", "--source", LAUNCHER_C]);
  assert.equal(dead.status, 8);
  assert.equal(dead.json.details.ownerState, "dead");
  assert.deepEqual(await statFacts(deadLock), deadBefore);
  assert.deepEqual((await fsp.readdir(deadArm)).filter((name) => name.startsWith(".stale-")), []);
  await releaseTestLock(deadLock);

  const missingProject = await mkProject("l21c");
  const missingArm = path.join(missingProject.proj, "releases", "launcher-candidates", "macos-arm64");
  await fsp.mkdir(missingArm, { recursive: true });
  const missingLock = path.join(missingArm, ".shiguang-launcher-publish.lock");
  await fsp.mkdir(missingLock, { mode: 0o700 });
  const missing = runCli(missingProject.proj, ["build", "--source", LAUNCHER_C]);
  assert.equal(missing.status, 8);
  assert.equal(missing.json.details.ownerState, "missing");
  assert.deepEqual(await fsp.readdir(missingLock), []);
  await fsp.rmdir(missingLock);

  const badProject = await mkProject("l21d");
  const badArm = path.join(badProject.proj, "releases", "launcher-candidates", "macos-arm64");
  await fsp.mkdir(badArm, { recursive: true });
  const badLock = path.join(badArm, ".shiguang-launcher-publish.lock");
  await createTestLock(badLock, "{not-json}\n");
  const bad = runCli(badProject.proj, ["build", "--source", LAUNCHER_C]);
  assert.equal(bad.status, 8);
  assert.equal(bad.json.details.ownerState, "malformed");
  assert.equal(await fsp.readFile(path.join(badLock, "owner.json"), "utf8"), "{not-json}\n");
  await releaseTestLock(badLock);
});

test("L21-e/f/g 等待中正常释放、双竞争者不接管、释放未确认", { timeout: 120_000 }, async () => {
  const project = await mkProject("l21e");
  const arm64 = path.join(project.proj, "releases", "launcher-candidates", "macos-arm64");
  await fsp.mkdir(arm64, { recursive: true });
  const lockDir = path.join(arm64, ".shiguang-launcher-publish.lock");
  await createTestLock(lockDir);
  const child = runCliAsync(project.proj, ["build", "--source", LAUNCHER_C]);
  await waitForStages(arm64, 1);
  await delay(200);
  await releaseTestLock(lockDir);
  const result = await child;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.changed, true);

  const competitorProject = await mkProject("l21f");
  const compArm = path.join(competitorProject.proj, "releases", "launcher-candidates", "macos-arm64");
  await fsp.mkdir(compArm, { recursive: true });
  const compLock = path.join(compArm, ".shiguang-launcher-publish.lock");
  await createTestLock(compLock, lockOwner(999999));
  const compBefore = await statFacts(compLock);
  const one = runCliAsync(competitorProject.proj, ["build", "--source", LAUNCHER_C]);
  const two = runCliAsync(competitorProject.proj, ["build", "--source", LAUNCHER_C]);
  const [c1, c2] = await Promise.all([one, two]);
  assert.equal(c1.status, 8);
  assert.equal(c2.status, 8);
  assert.deepEqual(await statFacts(compLock), compBefore);
  assert.deepEqual((await fsp.readdir(compArm)).filter((name) => !name.startsWith(".")), []);
  assert.deepEqual((await fsp.readdir(compArm)).filter((name) => name.startsWith(".stale-")), []);
  await releaseTestLock(compLock);

  const unknownProject = await mkProject("l21g");
  const unknownDir = await installDir(unknownProject);
  const unknownLock = path.join(unknownDir, ".shiguang-launcher-publish.lock");
  const padded = Buffer.alloc(12 * 1024 * 1024);
  const originalBinary = await fsp.readFile(base.artifact);
  originalBinary.copy(padded, 0, 0, 16);
  const unknownTmp = path.join(unknownProject.tmp, "padded-launcher");
  await fsp.writeFile(unknownTmp, padded, { mode: 0o500 });
  const paddedSha = sha256(padded);
  const installPromise = runCliAsync(unknownProject.proj, [
    "install",
    "--artifact",
    unknownTmp,
    "--sha256",
    paddedSha,
    "--dir",
    unknownDir,
  ]);
  const observedLock = await waitFor(
    async () => fs.existsSync(path.join(unknownLock, "owner.json")),
    10_000,
    1,
  );
  assert.ok(observedLock, "未观察到 install 自己创建的锁");
  await fsp.chmod(unknownLock, 0o500);
  const releaseResult = await installPromise;
  assert.equal(releaseResult.status, 0, releaseResult.stderr);
  assert.deepEqual(releaseResult.json.warnings, ["LOCK_RELEASE_UNKNOWN"]);
  assert.equal(releaseResult.json.cleanup, "unknown");
  assert.ok(fs.existsSync(path.join(unknownLock, "owner.json")));
  const stillBusy = runCli(unknownProject.proj, [
    "install",
    "--artifact",
    unknownTmp,
    "--sha256",
    paddedSha,
    "--dir",
    unknownDir,
  ]);
  assert.equal(stillBusy.status, 8);
  await fsp.chmod(unknownLock, 0o700);
  await releaseTestLock(unknownLock);
});

test("L22 artifact 校验后替换：发布已校验 Buffer", { timeout: 90_000 }, async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "launcher-test-art-"));
  temps.push(tmp);
  const artifactCopy = path.join(tmp, "artifact-launcher");
  await fsp.copyFile(base.artifact, artifactCopy);
  const snapshot = await __testInternals.readArtifactSnapshot(artifactCopy, base.sha);
  await fsp.chmod(artifactCopy, 0o600);
  const replacement = Buffer.from(await fsp.readFile(artifactCopy));
  replacement[Math.floor(replacement.length / 4)] ^= 0x02;
  await fsp.writeFile(artifactCopy, replacement);
  const published = path.join(tmp, "published-launcher");
  await fsp.writeFile(published, snapshot.buffer, { mode: 0o500 });
  assert.equal(sha256(await fsp.readFile(published)), base.sha);
  const exclusive = await __testInternals.publishFileExclusive(published, path.join(tmp, "linked-launcher"));
  assert.equal(exclusive.created, true);
  assert.equal(sha256(await fsp.readFile(path.join(tmp, "linked-launcher"))), base.sha);
});

test("L23 verify 纯只读：不建锁/tmp/stage，stat 不变", { timeout: 90_000 }, async () => {
  const project = await mkProject("l23");
  const dir = await installDir(project);
  const before = await statFacts(base.artifact);
  const dirBefore = await statFacts(dir);
  const result = runCli(project.proj, ["verify", "--artifact", base.artifact, "--sha256", base.sha]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await statFacts(base.artifact), before);
  assert.deepEqual(await statFacts(dir), dirBefore);
  assert.deepEqual((await fsp.readdir(dir)).filter((name) => name.includes(".shiguang-") || TMP_RE.test(name)), []);
});
