/**
 * T-MUSIC-ENGINE-CANDIDATE 实施轮定向测试。
 *
 * 只用临时目录、合成普通文件与本机回环 TLS；不执行候选二进制、不下载真实引擎、
 * 不访问正式服务器/数据库/作者素材库。所有变异用独立 node:crypto/shasum 语义重算。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { gzipSync, gunzipSync } from "node:zlib";
import tar from "tar-stream";
import { AudioEngine } from "../server/audio-engine.mjs";
import {
  makeRelease,
  makeTar,
  makeTlsFixture,
  startTlsServer,
  tempDir,
  waitForJob,
} from "./audio-engine-fixtures.mjs";

const PROJECT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(PROJECT, "scripts", "build-audio-engine-candidate.mjs");
const MiB = 1024 * 1024;
const execFileAsync = promisify(execFile);

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function runCli(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd: PROJECT,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, stdout, stderr, json: parseLine(stdout) };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
      json: parseLine(error.stderr || ""),
    };
  }
}

function parseLine(text) {
  const line = String(text || "").trim().split("\n").filter(Boolean).pop();
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * P2-1：测试根默认保留，不做 pathname-only 递归删除。
 * #0267 最小选择：after 完全不做新 FS 采集——不 lstat/stat/readdir/opendir/read，
 * 也不 rm/unlink/rename；只回显创建时已登记的 root 与 dev/ino，并明确声明
 * 当前身份/内容 UNKNOWN、未检查、未删除。根/外来字节因此一律原样保留。
 *
 * 产品 CLI 的 close/cleanup 责任不变；这里只是测试 teardown 的零 FS 记录，
 * 不假装当前身份已核、inventory 已枚举或资源已关。
 */
async function makeRoot(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cand-tool-")));
  const created = await fs.lstat(root);
  const identity = { dev: created.dev, ino: created.ino };
  const note = typeof t.diagnostic === "function" ? t.diagnostic.bind(t) : () => {};
  t.after(() => {
    note(
      `candidate test root record retained; current identity/contents UNKNOWN (created dev=${identity.dev} ino=${identity.ino}); no FS inspection, not deleted: ${root}`,
    );
  });
  return root;
}

async function makeInput(root, size = 4096, name = "input.bin") {
  const file = path.join(root, name);
  const buffer = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) buffer[i] = (i * 31 + 7) & 0xff;
  await fs.writeFile(file, buffer);
  return { file, size, sha256: sha256(buffer) };
}

async function buildCandidate(t, { size = 4096, version = "1.0.0" } = {}) {
  const root = await makeRoot(t);
  const input = await makeInput(root, size);
  const outDir = path.join(root, "out");
  const result = await runCli([
    "build",
    "--input",
    input.file,
    "--input-sha256",
    input.sha256,
    "--input-size",
    String(input.size),
    "--version",
    version,
    "--platform",
    "darwin",
    "--arch",
    "arm64",
    "--out-dir",
    outDir,
  ]);
  assert.equal(result.code, 0, result.stderr);
  const archiveName = `audio-engine-${version}-darwin-arm64.candidate.tar.gz`;
  const archive = path.join(outDir, archiveName);
  return {
    root,
    input,
    outDir,
    archive,
    archiveName,
    description: path.join(outDir, "candidate.json"),
    sums: path.join(outDir, "SHA256SUMS"),
    complete: path.join(outDir, "COMPLETE"),
    built: result.json,
  };
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value));
}

/** 按 SYNC-A 同步外层：归档字节变了就重算描述/sums/COMPLETE 的 bytes+sha。 */
async function syncOuter(outDir) {
  const archiveName = (await fs.readdir(outDir)).find((name) => name.endsWith(".candidate.tar.gz"));
  const archivePath = path.join(outDir, archiveName);
  const archive = await fs.readFile(archivePath);
  const description = await readJson(path.join(outDir, "candidate.json"));
  description.candidate.file = archiveName;
  description.candidate.bytes = archive.length;
  description.candidate.sha256 = sha256(archive);
  const descriptionBuffer = Buffer.from(JSON.stringify(description));
  await fs.writeFile(path.join(outDir, "candidate.json"), descriptionBuffer);
  const descriptionSha = sha256(descriptionBuffer);
  const sumsBuffer = Buffer.from(
    `${description.candidate.sha256}  ${archiveName}\n${descriptionSha}  candidate.json\n`,
  );
  await fs.writeFile(path.join(outDir, "SHA256SUMS"), sumsBuffer);
  const complete = await readJson(path.join(outDir, "COMPLETE"));
  complete.archive = { file: archiveName, bytes: archive.length, sha256: description.candidate.sha256 };
  complete.description = { file: "candidate.json", bytes: descriptionBuffer.length, sha256: descriptionSha };
  complete.sums = { file: "SHA256SUMS", bytes: sumsBuffer.length, sha256: sha256(sumsBuffer) };
  await writeJson(path.join(outDir, "COMPLETE"), complete);
  return { archiveName, archivePath, archive };
}

async function copyCase(sourceDir, targetDir, archiveName) {
  await fs.mkdir(targetDir, { recursive: true });
  for (const name of [archiveName, "candidate.json", "SHA256SUMS", "COMPLETE"]) {
    await fs.copyFile(path.join(sourceDir, name), path.join(targetDir, name));
  }
  return path.join(targetDir, archiveName);
}

async function expectVerifyCode(outDir, code) {
  const result = await runCli(["verify", "--dir", outDir]);
  assert.equal(result.code, code, `期望 exit ${code}，实际 ${result.code}: ${result.stderr}`);
  return result.json;
}

/**
 * 一次性 preload 故障注射：只在测试子 CLI 内生效，不 patch 父进程，
 * 不新增产品参数/环境后门；缩短 deadline 只用于本测试。
 */
const PRELOAD_SOURCE = `
import fsp from "node:fs/promises";
import fs from "node:fs";
const mode = process.env.CAND_TEST_MODE || "";
const fast = mode.startsWith("p2-");
const origOpen = fsp.open.bind(fsp);
const origSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = function (fn, ms, ...rest) {
  if (typeof ms === "number" && ms >= 60000) ms = fast ? 100 : 600;
  return origSetTimeout(fn, ms, ...rest);
};
if (mode === "p2-stall-readdir") {
  fsp.readdir = () => new Promise(() => {});
}
if (mode === "p2-readdir-eacces") {
  fsp.readdir = async () => {
    const error = new Error("injected EACCES");
    error.code = "EACCES";
    throw error;
  };
}
if (mode === "stall-write" || mode === "stall-write-close" || mode === "stall-all") {
  fs.write = function () {};
}
if (mode === "fail-write") {
  fs.write = function (fd, buffer, offset, length, position, callback) {
    const cb = typeof position === "function" ? position : callback;
    const error = new Error("injected ENOSPC");
    error.code = "ENOSPC";
    process.nextTick(() => cb(error));
  };
}
if (mode === "stall-write-close" || mode === "stall-all") {
  fs.close = function () {};
}
fsp.open = async function (file, ...rest) {
  const name = String(file);
  if (mode === "p2-stall-open" && name.endsWith("candidate.json")) {
    return new Promise(() => {});
  }
  if (mode === "p2-slow-open" && name.endsWith("candidate.json")) {
    await new Promise((resolve) => origSetTimeout(resolve, 300));
  }
  if (mode === "dir-fsync-fail") {
    try {
      if (fs.statSync(name).isDirectory()) {
        const error = new Error("injected dir open EIO");
        error.code = "EIO";
        throw error;
      }
    } catch (error) {
      if (error.code === "EIO") throw error;
    }
  }
  if (mode === "fail-description" && name.endsWith("candidate.json")) {
    const error = new Error("injected EIO");
    error.code = "EIO";
    throw error;
  }
  const handle = await origOpen(file, ...rest);
  if (mode === "p2-stall-metadata-write" && name.endsWith("candidate.json")) {
    handle.write = (...writeArgs) =>
      new Promise((resolve) => origSetTimeout(() => resolve({ bytesWritten: writeArgs[2] }), 5000));
  }
  if (mode === "p2-late-reject" && name.endsWith("candidate.json")) {
    handle.write = () =>
      new Promise((_, reject) => {
        const error = new Error("injected late EIO");
        error.code = "EIO";
        origSetTimeout(() => reject(error), 300);
      });
  }
  if (mode === "p2-stall-metadata-sync" && name.endsWith("candidate.json")) {
    handle.sync = () => new Promise(() => {});
  }
  if (mode === "p2-stall-diagnostic-write" && name.endsWith("FAILED.json")) {
    handle.writeFile = () => new Promise(() => {});
  }
  if (mode === "stall-read" || mode === "stall-read-close" || mode === "cancel" || mode === "stall-all") {
    let rejectRead;
    const stalled = new Promise((_, reject) => { rejectRead = reject; });
    stalled.catch(() => {});
    handle.read = () => stalled;
    const origClose = handle.close.bind(handle);
    handle.close = () => {
      const error = new Error("injected read aborted by close");
      error.code = "EBADF";
      rejectRead(error);
      return origClose();
    };
  }
  if (mode === "stall-read-forever" || mode === "p2-stall-read-forever") {
    handle.read = () => new Promise(() => {});
  }
  if (mode === "stall-read-close" || mode === "stall-all") {
    const settlingClose = handle.close;
    handle.close = () => {
      settlingClose();
      return new Promise(() => {});
    };
  }
  if ((mode === "archive-append" || mode === "archive-truncate") && name.endsWith(".candidate.tar.gz")) {
    const originalRead = handle.read.bind(handle);
    let mutated = false;
    handle.read = async (...args) => {
      const result = await originalRead(...args);
      if (!mutated && result.bytesRead > 0) {
        mutated = true;
        if (mode === "archive-append") fs.appendFileSync(name, "x");
        else fs.truncateSync(name, fs.statSync(name).size - 1);
      }
      return result;
    };
  }
  if (mode === "desc-partial" && name.endsWith("candidate.json")) {
    const originalRead = handle.read.bind(handle);
    let mutated = false;
    handle.read = async (buffer, offset, length, position) => {
      if (!mutated) {
        mutated = true;
        const result = await originalRead(buffer, offset, Math.min(10, length), position);
        const text = fs.readFileSync(name, "utf8");
        if (text.includes('"1.0.0"')) fs.writeFileSync(name, text.replace('"1.0.0"', '"1.0.1"'));
        return result;
      }
      return originalRead(buffer, offset, length, position);
    };
  }
  if (mode === "desc-after-eof" && name.endsWith("candidate.json")) {
    const originalRead = handle.read.bind(handle);
    let mutated = false;
    handle.read = async (buffer, offset, length, position) => {
      const result = await originalRead(buffer, offset, length, position);
      if (!mutated && result.bytesRead > 0 && result.bytesRead === length) {
        mutated = true;
        const text = fs.readFileSync(name, "utf8");
        if (text.includes('"1.0.0"')) fs.writeFileSync(name, text.replace('"1.0.0"', '"1.0.2"'));
      }
      return result;
    };
  }
  if (mode === "input-append" && name.endsWith("input.bin")) {
    const originalRead = handle.read.bind(handle);
    let mutated = false;
    handle.read = async (...args) => {
      const result = await originalRead(...args);
      if (!mutated) {
        mutated = true;
        fs.appendFileSync(name, "x");
      }
      return result;
    };
  }
  return handle;
};
if (mode === "race-archive") {
  const originalOpen = fs.open;
  fs.open = function (file, flags, ...rest) {
    if (String(file).endsWith(".candidate.tar.gz")) fs.writeFileSync(file, "FOREIGN");
    return originalOpen.call(fs, file, flags, ...rest);
  };
}
`;

async function writePreload(root) {
  const file = path.join(root, "preload.mjs");
  await fs.writeFile(file, PRELOAD_SOURCE);
  return file;
}

const BUILD_ARGS = (input, outDir) => [
  "build",
  "--input",
  input.file,
  "--input-sha256",
  input.sha256,
  "--input-size",
  String(input.size),
  "--version",
  "1.0.0",
  "--platform",
  "darwin",
  "--arch",
  "arm64",
  "--out-dir",
  outDir,
];

async function runCliWithPreload(args, preload, mode) {
  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [`--import=${pathToFileURL(preload).href}`, CLI, ...args],
      {
        cwd: PROJECT,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, CAND_TEST_MODE: mode },
      },
    );
    return { code: 0, stdout, stderr, json: parseLine(stdout), elapsed: Date.now() - started };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
      json: parseLine(error.stderr || ""),
      elapsed: Date.now() - started,
    };
  }
}

async function runCliSignal(args, preload, mode, signalAfter = 250) {
  const child = spawn(process.execPath, [`--import=${pathToFileURL(preload).href}`, CLI, ...args], {
    cwd: PROJECT,
    env: { ...process.env, CAND_TEST_MODE: mode },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const started = Date.now();
  setTimeout(() => child.kill("SIGTERM"), signalAfter);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout, stderr, json: parseLine(stderr), elapsed: Date.now() - started };
}

async function makeMalformed(input, outDir) {
  // 先产生合法包，再由调用方替换归档并同步外层；description/sums/COMPLETE 一并重算。
  const root = path.dirname(outDir);
  const candidate = await buildCandidateAt(input, outDir, root);
  return candidate;
}

async function buildCandidateAt(input, outDir, root) {
  const result = await runCli(BUILD_ARGS(input, outDir));
  assert.equal(result.code, 0, result.stderr);
  return {
    input,
    outDir,
    archive: path.join(outDir, "audio-engine-1.0.0-darwin-arm64.candidate.tar.gz"),
    archiveName: "audio-engine-1.0.0-darwin-arm64.candidate.tar.gz",
    description: path.join(outDir, "candidate.json"),
    sums: path.join(outDir, "SHA256SUMS"),
    complete: path.join(outDir, "COMPLETE"),
    root,
    built: result.json,
  };
}

test("J01: build 只声明 produced，verify --dir 才 contentComplete", async (t) => {
  const candidate = await buildCandidate(t);
  assert.equal(candidate.built.ok, true);
  assert.equal(candidate.built.mode, "build");
  assert.equal(candidate.built.complete.state, "produced");
  assert.equal(candidate.built.complete.contentComplete, false);
  assert.equal(candidate.built.complete.contentVerifiedBy, null);
  assert.equal(candidate.built.complete.durable, "not-claimed");
  assert.equal(candidate.built.externalArchivePin, false);
  assert.equal(candidate.built.externalDescriptionPin, false);
  assert.equal(candidate.built.member.name, "audio-analyze");
  assert.equal(candidate.built.member.bytes, candidate.input.size);
  assert.equal(candidate.built.member.sha256, candidate.input.sha256);

  const verify = await runCli(["verify", "--dir", candidate.outDir]);
  assert.equal(verify.code, 0, verify.stderr);
  assert.equal(verify.json.mode, "verify-dir");
  assert.equal(verify.json.complete.contentComplete, true);
  assert.equal(verify.json.complete.contentVerifiedBy, "verify-dir");
  assert.equal(verify.json.complete.state, "produced");
  assert.equal(verify.json.externalArchivePin, false);
  assert.equal(verify.json.externalDescriptionPin, false);
  assert.deepEqual(verify.json.declared, { version: "1.0.0", platform: "darwin", arch: "arm64" });

  const archive = await runCli([
    "verify",
    "--archive",
    candidate.archive,
    "--description",
    candidate.description,
    "--expect-archive-sha256",
    sha256(await fs.readFile(candidate.archive)),
    "--expect-archive-size",
    String((await fs.stat(candidate.archive)).size),
  ]);
  assert.equal(archive.code, 0, archive.stderr);
  assert.equal(archive.json.mode, "verify-archive");
  assert.deepEqual(archive.json.complete, { checked: false });
  assert.equal(archive.json.externalArchivePin, true);
  assert.equal(archive.json.externalDescriptionPin, false);
});

test("无覆盖：out-dir 已存在 exit 4，且不改原目录", async (t) => {
  const candidate = await buildCandidate(t);
  const before = await fs.readFile(candidate.complete);
  const again = await runCli([
    "build",
    "--input",
    candidate.input.file,
    "--input-sha256",
    candidate.input.sha256,
    "--input-size",
    String(candidate.input.size),
    "--version",
    "1.0.0",
    "--platform",
    "darwin",
    "--arch",
    "arm64",
    "--out-dir",
    candidate.outDir,
  ]);
  assert.equal(again.code, 4);
  assert.equal(again.json.code, "CANDIDATE_OUTPUT_EXISTS");
  assert.deepEqual(await fs.readFile(candidate.complete), before);
});

test("输入边界：符号链接 3、pin 不符 3、平台不符 2", async (t) => {
  const root = await makeRoot(t);
  const input = await makeInput(root, 1024);
  const link = path.join(root, "link.bin");
  await fs.symlink(input.file, link);
  const linked = await runCli([
    "build",
    "--input",
    link,
    "--input-sha256",
    input.sha256,
    "--input-size",
    String(input.size),
    "--version",
    "1.0.0",
    "--platform",
    "darwin",
    "--arch",
    "arm64",
    "--out-dir",
    path.join(root, "out-link"),
  ]);
  assert.equal(linked.code, 3);
  assert.equal(linked.json.code, "CANDIDATE_INPUT_UNSAFE");

  const mismatch = await runCli([
    "build",
    "--input",
    input.file,
    "--input-sha256",
    input.sha256,
    "--input-size",
    String(input.size + 1),
    "--version",
    "1.0.0",
    "--platform",
    "darwin",
    "--arch",
    "arm64",
    "--out-dir",
    path.join(root, "out-mismatch"),
  ]);
  assert.equal(mismatch.code, 3);
  assert.equal(mismatch.json.code, "CANDIDATE_INPUT_PIN_MISMATCH");

  const platform = await runCli([
    "build",
    "--input",
    input.file,
    "--input-sha256",
    input.sha256,
    "--input-size",
    String(input.size),
    "--version",
    "1.0.0",
    "--platform",
    "linux",
    "--arch",
    "arm64",
    "--out-dir",
    path.join(root, "out-platform"),
  ]);
  assert.equal(platform.code, 2);
  assert.equal(platform.json.code, "CANDIDATE_UNSUPPORTED_TARGET");
  assert.equal(await fs.stat(path.join(root, "out-platform")).catch(() => null), null);
});

test("verify 不接受 --version/--expect-version（幽灵参数 2）", async (t) => {
  const candidate = await buildCandidate(t);
  for (const extra of [["--version", "1.0.0"], ["--expect-version", "1.0.0"]]) {
    const result = await runCli(["verify", "--dir", candidate.outDir, ...extra]);
    assert.equal(result.code, 2);
    assert.equal(result.json.code, "CANDIDATE_USAGE");
  }
});

test("I01/I02a: XFL 同 inode 同大小变异，旧 pin exit 6；全同步后 0", async (t) => {
  const candidate = await buildCandidate(t);
  const bytes = await fs.readFile(candidate.archive);
  const mutated = Buffer.from(bytes);
  mutated[8] ^= 0x01; // gzip XFL 自由字节，结构仍合法
  await fs.writeFile(candidate.archive, mutated);

  const oldSize = bytes.length;
  const oldSha = sha256(bytes);
  const verifyOld = await runCli([
    "verify",
    "--archive",
    candidate.archive,
    "--description",
    candidate.description,
    "--expect-archive-sha256",
    oldSha,
    "--expect-archive-size",
    String(oldSize),
  ]);
  assert.equal(verifyOld.code, 6, verifyOld.stderr);
  assert.equal(verifyOld.json.code, "CANDIDATE_ARCHIVE_MISMATCH");

  await syncOuter(candidate.outDir);
  const verifySynced = await runCli([
    "verify",
    "--archive",
    candidate.archive,
    "--description",
    candidate.description,
    "--expect-archive-sha256",
    sha256(mutated),
    "--expect-archive-size",
    String(mutated.length),
  ]);
  assert.equal(verifySynced.code, 0, verifySynced.stderr);
});

test("G02/G03/G05/G06/G07/G08/G09: 结构失败统一 exit 5", async (t) => {
  const candidate = await buildCandidate(t);
  const base = await fs.readFile(candidate.archive);
  const cases = [];
  {
    const buf = Buffer.from(base);
    const offset = buf.length - 8;
    [buf[offset], buf[offset + 3]] = [buf[offset + 3], buf[offset]];
    cases.push(["crc", buf]);
  }
  {
    const buf = Buffer.from(base);
    const offset = buf.length - 4;
    buf.writeUInt32LE((buf.readUInt32LE(offset) + 1) >>> 0, offset);
    cases.push(["isize", buf]);
  }
  cases.push(["truncated-trailer", base.subarray(0, base.length - 1)]);
  cases.push([
    "second-empty-member",
    Buffer.concat([
      base,
      Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0, 0x03, 0x03, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]),
    ]),
  ]);
  cases.push(["trailing-junk", Buffer.concat([base, Buffer.from("JUNKJUNK")])]);
  {
    const buf = Buffer.from(base);
    buf[0] = 0;
    cases.push(["bad-magic", buf]);
  }
  for (const [name, buffer] of cases) {
    const caseDir = path.join(candidate.root, `case-${name}`);
    const archivePath = await copyCase(candidate.outDir, caseDir, candidate.archiveName);
    await fs.writeFile(archivePath, buffer);
    await syncOuter(caseDir);
    const result = await expectVerifyCode(caseDir, 5);
    assert.equal(result.code, "CANDIDATE_ARCHIVE_INVALID", `${name}: ${JSON.stringify(result)}`);
  }
});

test("G10: tar 结尾额外零块拒绝（exit 5）", async (t) => {
  const candidate = await buildCandidate(t);
  const base = await fs.readFile(candidate.archive);
  const caseDir = path.join(candidate.root, "case-extra-zero");
  const archivePath = await copyCase(candidate.outDir, caseDir, candidate.archiveName);
  // 解压后的 tar 在标准 1024 B 结束块后再多一个全零块 -> 解压总长度多 512 B。
  const tarBytes = gunzipSync(base);
  await fs.writeFile(archivePath, gzipSync(Buffer.concat([tarBytes, Buffer.alloc(512)])));
  await syncOuter(caseDir);
  const result = await expectVerifyCode(caseDir, 5);
  assert.equal(result.code, "CANDIDATE_ARCHIVE_INVALID");
});

test("J17/H05: 旧 complete/单处 sums/描述非法都被拒绝", async (t) => {
  const candidate = await buildCandidate(t);

  const legacyDir = path.join(candidate.root, "case-legacy-complete");
  await fs.mkdir(legacyDir);
  for (const name of [candidate.archiveName, "candidate.json", "SHA256SUMS", "COMPLETE"]) {
    await fs.copyFile(path.join(candidate.outDir, name), path.join(legacyDir, name));
  }
  const complete = await readJson(path.join(legacyDir, "COMPLETE"));
  complete.state = "complete";
  await writeJson(path.join(legacyDir, "COMPLETE"), complete);
  let result = await expectVerifyCode(legacyDir, 6);
  assert.equal(result.code, "CANDIDATE_COMPLETE_INVALID");

  const sumsDir = path.join(candidate.root, "case-sums");
  await fs.mkdir(sumsDir);
  for (const name of [candidate.archiveName, "candidate.json", "SHA256SUMS", "COMPLETE"]) {
    await fs.copyFile(path.join(candidate.outDir, name), path.join(sumsDir, name));
  }
  const sums = await fs.readFile(path.join(sumsDir, "SHA256SUMS"), "utf8");
  const lines = sums.split("\n");
  lines[1] = `${"0".repeat(64)}  candidate.json`;
  const sumsBuffer = Buffer.from(lines.join("\n"));
  await fs.writeFile(path.join(sumsDir, "SHA256SUMS"), sumsBuffer);
  const complete2 = await readJson(path.join(sumsDir, "COMPLETE"));
  complete2.sums = { file: "SHA256SUMS", bytes: sumsBuffer.length, sha256: sha256(sumsBuffer) };
  await writeJson(path.join(sumsDir, "COMPLETE"), complete2);
  result = await expectVerifyCode(sumsDir, 6);
  assert.equal(result.code, "CANDIDATE_SUMS_INVALID");

  const descDir = path.join(candidate.root, "case-desc");
  await fs.mkdir(descDir);
  for (const name of [candidate.archiveName, "candidate.json", "SHA256SUMS", "COMPLETE"]) {
    await fs.copyFile(path.join(candidate.outDir, name), path.join(descDir, name));
  }
  const description = await readJson(path.join(descDir, "candidate.json"));
  description.declared.version = "2.0.0";
  await writeJson(path.join(descDir, "candidate.json"), description);
  result = await expectVerifyCode(descDir, 6);
  assert.equal(result.code, "CANDIDATE_DESCRIPTION_INVALID");
});

test("J14/J15/J16: 完成窗口归档替换/原地改后 verify-dir 必拒，且只读", async (t) => {
  const candidate = await buildCandidate(t);
  const original = await fs.readFile(candidate.archive);
  const decoy = Buffer.from(original);
  decoy[8] ^= 0x02; // 同大小、结构合法的另一份字节
  await fs.writeFile(candidate.archive, decoy);

  const inventoryBefore = (await fs.readdir(candidate.outDir)).sort();
  const hashesBefore = {};
  for (const name of inventoryBefore) {
    hashesBefore[name] = sha256(await fs.readFile(path.join(candidate.outDir, name)));
  }
  const result = await runCli(["verify", "--dir", candidate.outDir]);
  assert.equal(result.code, 6, result.stderr);
  assert.equal(result.json.code, "CANDIDATE_ARCHIVE_MISMATCH");
  const inventoryAfter = (await fs.readdir(candidate.outDir)).sort();
  assert.deepEqual(inventoryAfter, inventoryBefore);
  for (const name of inventoryAfter) {
    assert.equal(sha256(await fs.readFile(path.join(candidate.outDir, name))), hashesBefore[name]);
  }
});

test("描述外部 pin 与目录外部 pin 的真实语义", async (t) => {
  const candidate = await buildCandidate(t);
  const descriptionSha = sha256(await fs.readFile(candidate.description));
  const archive = await fs.readFile(candidate.archive);
  const ok = await runCli([
    "verify",
    "--dir",
    candidate.outDir,
    "--expect-archive-sha256",
    sha256(archive),
    "--expect-archive-size",
    String(archive.length),
    "--expect-description-sha256",
    descriptionSha,
  ]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.json.externalArchivePin, true);
  assert.equal(ok.json.externalDescriptionPin, true);

  const wrong = await runCli([
    "verify",
    "--dir",
    candidate.outDir,
    "--expect-description-sha256",
    "0".repeat(64),
  ]);
  assert.equal(wrong.code, 6);
  assert.equal(wrong.json.code, "CANDIDATE_DESCRIPTION_MISMATCH");
});

async function cloneOut(candidate, name) {
  const dir = path.join(candidate.root, name);
  await fs.mkdir(dir);
  for (const entry of [candidate.archiveName, "candidate.json", "SHA256SUMS", "COMPLETE"]) {
    await fs.copyFile(path.join(candidate.outDir, entry), path.join(dir, entry));
  }
  return dir;
}

async function renameDeclared(candidate, dir, oldName, newVersion, { skipSums = false, skipComplete = false } = {}) {
  const newName = `audio-engine-${newVersion}-darwin-arm64.candidate.tar.gz`;
  await fs.rename(path.join(dir, oldName), path.join(dir, newName));
  const description = await readJson(path.join(dir, "candidate.json"));
  description.declared.version = newVersion;
  description.candidate.file = newName;
  const descriptionBuffer = Buffer.from(JSON.stringify(description));
  await fs.writeFile(path.join(dir, "candidate.json"), descriptionBuffer);
  const descriptionSha = sha256(descriptionBuffer);
  let sumsBuffer;
  if (skipSums) {
    sumsBuffer = await fs.readFile(path.join(dir, "SHA256SUMS"));
  } else {
    sumsBuffer = Buffer.from(
      `${description.candidate.sha256}  ${newName}\n${descriptionSha}  candidate.json\n`,
    );
    await fs.writeFile(path.join(dir, "SHA256SUMS"), sumsBuffer);
  }
  if (!skipComplete) {
    const complete = await readJson(path.join(dir, "COMPLETE"));
    complete.description = { file: "candidate.json", bytes: descriptionBuffer.length, sha256: descriptionSha };
    complete.sums = { file: "SHA256SUMS", bytes: sumsBuffer.length, sha256: sha256(sumsBuffer) };
    complete.archive.file = newName;
    await writeJson(path.join(dir, "COMPLETE"), complete);
  }
  return newName;
}

test("J02/J03/J04/J10/J11: COMPLETE 缺失/截断/字段错、SUMS 畸形、archive-only 不读 COMPLETE", async (t) => {
  const candidate = await buildCandidate(t);
  const archiveSha = sha256(await fs.readFile(candidate.archive));
  const archiveSize = (await fs.stat(candidate.archive)).size;
  const archiveArgs = [
    "verify",
    "--archive",
    candidate.archive,
    "--description",
    candidate.description,
    "--expect-archive-sha256",
    archiveSha,
    "--expect-archive-size",
    String(archiveSize),
  ];

  const missing = await cloneOut(candidate, "case-missing-complete");
  await fs.rm(path.join(missing, "COMPLETE"));
  assert.equal((await expectVerifyCode(missing, 6)).code, "CANDIDATE_COMPLETE_INVALID");

  const truncated = await cloneOut(candidate, "case-truncated-complete");
  await fs.writeFile(path.join(truncated, "COMPLETE"), Buffer.from('{"schema":"x"'));
  assert.equal((await expectVerifyCode(truncated, 6)).code, "CANDIDATE_COMPLETE_INVALID");

  const wrongField = await cloneOut(candidate, "case-wrong-complete");
  const complete = await readJson(path.join(wrongField, "COMPLETE"));
  complete.archive.sha256 = "0".repeat(64);
  await writeJson(path.join(wrongField, "COMPLETE"), complete);
  assert.equal((await expectVerifyCode(wrongField, 6)).code, "CANDIDATE_COMPLETE_INVALID");

  const badSums = await cloneOut(candidate, "case-bad-sums");
  const sums = await fs.readFile(path.join(badSums, "SHA256SUMS"), "utf8");
  await fs.writeFile(path.join(badSums, "SHA256SUMS"), `${sums}extra\n`);
  assert.equal((await expectVerifyCode(badSums, 6)).code, "CANDIDATE_SUMS_INVALID");

  // J11：COMPLETE 被删后 archive-only 仍按归档/描述成功，且不冒充目录完成。
  await fs.rm(candidate.complete);
  const archiveOnly = await runCli(archiveArgs);
  assert.equal(archiveOnly.code, 0, archiveOnly.stderr);
  assert.deepEqual(archiveOnly.json.complete, { checked: false });
});

test("H03/H05a-d: 版本语法、自洽重命名与外部 pin 边界", async (t) => {
  const root = await makeRoot(t);
  const input = await makeInput(root, 2048);
  for (const version of ["", ".", "..", "a/b", "a b", "x".repeat(65)]) {
    const result = await runCli([
      "build",
      "--input",
      input.file,
      "--input-sha256",
      input.sha256,
      "--input-size",
      String(input.size),
      "--version",
      version,
      "--platform",
      "darwin",
      "--arch",
      "arm64",
      "--out-dir",
      path.join(root, `out-${Buffer.from(version).toString("hex") || "empty"}`),
    ]);
    if (version === "") {
      // 空值在参数层就是缺值 -> USAGE；其余非法版本同样 USAGE。
      assert.equal(result.code, 2, JSON.stringify(result));
    } else {
      assert.equal(result.code, 2, `${JSON.stringify(version)}: ${result.stderr}`);
    }
    assert.equal(result.json.code, "CANDIDATE_USAGE");
  }

  const candidate = await buildCandidate(t);
  const synced = await cloneOut(candidate, "case-h05a");
  await renameDeclared(candidate, synced, candidate.archiveName, "2.0.0");
  const ok = await runCli(["verify", "--dir", synced]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.json.externalDescriptionPin, false);
  assert.equal(ok.json.declared.version, "2.0.0");

  const missingSums = await cloneOut(candidate, "case-h05b");
  await renameDeclared(candidate, missingSums, candidate.archiveName, "2.0.1", { skipSums: true });
  assert.equal((await expectVerifyCode(missingSums, 6)).code, "CANDIDATE_SUMS_INVALID");

  const missingComplete = await cloneOut(candidate, "case-h05c");
  await renameDeclared(candidate, missingComplete, candidate.archiveName, "2.0.2", { skipComplete: true });
  assert.equal((await expectVerifyCode(missingComplete, 6)).code, "CANDIDATE_COMPLETE_INVALID");

  const oldPin = await runCli([
    "verify",
    "--dir",
    synced,
    "--expect-description-sha256",
    sha256(await fs.readFile(candidate.description)),
  ]);
  assert.equal(oldPin.code, 6);
  assert.equal(oldPin.json.code, "CANDIDATE_DESCRIPTION_MISMATCH");
});

test("L02/L03: 初始父 symlink 与非可信 symlink 祖先 exit 4", async (t) => {
  const root = await makeRoot(t);
  const input = await makeInput(root, 1024);
  const realParent = path.join(root, "real-parent");
  await fs.mkdir(realParent);
  const linkParent = path.join(root, "link-parent");
  await fs.symlink(realParent, linkParent);
  const args = (outDir) => [
    "build",
    "--input",
    input.file,
    "--input-sha256",
    input.sha256,
    "--input-size",
    String(input.size),
    "--version",
    "1.0.0",
    "--platform",
    "darwin",
    "--arch",
    "arm64",
    "--out-dir",
    outDir,
  ];
  const viaLink = await runCli(args(path.join(linkParent, "out")));
  assert.equal(viaLink.code, 4, viaLink.stderr);
  assert.equal(viaLink.json.code, "CANDIDATE_OUTPUT_UNSAFE");
  assert.equal(await fs.stat(path.join(realParent, "out")).catch(() => null), null);
});

test("M01/M02: 描述 4096 边界与 COMPLETE 1024 上限", async (t) => {
  const candidate = await buildCandidate(t);
  const originalDescription = await fs.readFile(candidate.description);
  const padded = Buffer.concat([originalDescription, Buffer.alloc(4097 - originalDescription.length, 0x20)]);
  await fs.writeFile(candidate.description, padded);
  const tooBig = await runCli([
    "verify",
    "--archive",
    candidate.archive,
    "--description",
    candidate.description,
    "--expect-archive-sha256",
    sha256(await fs.readFile(candidate.archive)),
    "--expect-archive-size",
    String((await fs.stat(candidate.archive)).size),
  ]);
  assert.equal(tooBig.code, 6);
  assert.equal(tooBig.json.code, "CANDIDATE_DESCRIPTION_INVALID");
  await fs.writeFile(candidate.description, originalDescription);

  const complete = await fs.readFile(candidate.complete);
  await fs.writeFile(candidate.complete, Buffer.concat([complete, Buffer.alloc(1025 - complete.length, 0x20)]));
  const markerTooBig = await runCli(["verify", "--dir", candidate.outDir]);
  assert.equal(markerTooBig.code, 6);
  assert.equal(markerTooBig.json.code, "CANDIDATE_COMPLETE_INVALID");
});

test("真实 AudioEngine 安装器兼容：新候选可装，._audio-analyze 旧式归档仍拒", async (t) => {
  const root = await makeRoot(t);
  const candidate = await buildCandidate(t, { size: 8192 });
  const archive = await fs.readFile(candidate.archive);
  const tls = await makeTlsFixture(t);
  let body = archive;
  const server = await startTlsServer(t, tls, async (req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": body.length });
    res.end(body);
  });
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir, { recursive: true });
  const release = makeRelease(archive, server.url, {
    version: "1.0.0",
    archiveMaxBytes: 130 * MiB,
    extractedMaxBytes: 256 * MiB,
  });
  const engine = new AudioEngine(dataDir, {
    release,
    ca: tls.ca,
    platform: "darwin",
    arch: "arm64",
    idleTimeoutMs: 1000,
    totalTimeoutMs: 5000,
    diskFreeBytes: 1024 * 1024 * 1024,
  });
  t.after(() => engine.dispose());
  engine.install({ confirm: true });
  const status = await waitForJob(engine);
  assert.equal(status.job.state, "installed", JSON.stringify(status));
  const current = await readJson(path.join(dataDir, "engines/audio/current.json"));
  assert.equal(current.releaseSha256, release.sha256);
  const versionDir = path.join(dataDir, "engines/audio/versions", current.dir);
  const marker = await readJson(path.join(versionDir, ".installed.json"));
  assert.equal(marker.releaseSha256, release.sha256);
  assert.equal(marker.binarySha256, candidate.built.member.sha256);
  assert.equal(marker.binarySize, candidate.input.size);
  const installed = await fs.readFile(path.join(versionDir, "audio-analyze"));
  assert.equal(sha256(installed), candidate.input.sha256);
  assert.equal((await fs.stat(path.join(versionDir, "audio-analyze"))).mode & 0o777, 0o755);

  // 负例：含 AppleDouble 隐藏成员的旧式合成归档必须仍被安装器拒绝。
  const binary = Buffer.from("#!/bin/sh\necho synth\n");
  const unsafe = await makeTar([
    { name: "._audio-analyze", data: Buffer.alloc(163, 0x41), mode: 0o755 },
    { name: "audio-analyze", data: binary, mode: 0o755 },
  ]);
  const unsafeDir = path.join(root, "data-unsafe");
  await fs.mkdir(unsafeDir, { recursive: true });
  body = unsafe;
  const unsafeRelease = makeRelease(unsafe, server.url, {
    version: "1.0.0",
    archiveMaxBytes: 130 * MiB,
    extractedMaxBytes: 256 * MiB,
  });
  const unsafeEngine = new AudioEngine(unsafeDir, {
    release: unsafeRelease,
    ca: tls.ca,
    platform: "darwin",
    arch: "arm64",
    idleTimeoutMs: 1000,
    totalTimeoutMs: 5000,
    diskFreeBytes: 1024 * 1024 * 1024,
  });
  t.after(() => unsafeEngine.dispose());
  unsafeEngine.install({ confirm: true });
  const unsafeStatus = await waitForJob(unsafeEngine);
  assert.equal(unsafeStatus.job.state, "error");
  assert.equal(unsafeStatus.job.error.code, "ENGINE_ARCHIVE_UNSAFE");
});

/* ───────────────────── A/B：正常、独立解析、路径与输入边界 ───────────────────── */

test("A02/A03/A04: 独立解析成员、verify 幂等只读、同运行时重打可复现", async (t) => {
  const candidate = await buildCandidate(t);
  const archive = await fs.readFile(candidate.archive);
  // gzip 头固定：FLG=0、MTIME=0；独立于工具的 verify 结论。
  assert.equal(archive[3], 0);
  assert.equal(archive.readUInt32LE(4), 0);
  const entries = [];
  await new Promise((resolve, reject) => {
    const extract = tar.extract();
    extract.on("entry", (header, stream, next) => {
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", () => {
        entries.push({ header, data: Buffer.concat(chunks) });
        next();
      });
      stream.resume();
    });
    extract.on("error", reject);
    extract.on("finish", resolve);
    extract.end(gunzipSync(archive));
  });
  assert.equal(entries.length, 1);
  const [{ header, data }] = entries;
  assert.equal(header.name, "audio-analyze");
  assert.equal(header.type, "file");
  assert.equal(header.size, candidate.input.size);
  assert.equal(header.mode, 0o755);
  assert.equal(header.uid, 0);
  assert.equal(header.gid, 0);
  assert.equal(header.mtime.getTime(), 0);
  assert.equal(sha256(data), candidate.input.sha256);

  const inventory = (await fs.readdir(candidate.outDir)).sort();
  const hashes = {};
  for (const name of inventory) hashes[name] = sha256(await fs.readFile(path.join(candidate.outDir, name)));
  const one = await runCli([
    "verify", "--archive", candidate.archive, "--description", candidate.description,
    "--expect-archive-sha256", sha256(archive), "--expect-archive-size", String(archive.length),
  ]);
  const two = await runCli([
    "verify", "--archive", candidate.archive, "--description", candidate.description,
    "--expect-archive-sha256", sha256(archive), "--expect-archive-size", String(archive.length),
  ]);
  assert.equal(one.code, 0, one.stderr);
  assert.equal(two.code, 0, two.stderr);
  assert.equal(one.stdout, two.stdout);
  assert.deepEqual((await fs.readdir(candidate.outDir)).sort(), inventory);
  for (const name of inventory) {
    assert.equal(sha256(await fs.readFile(path.join(candidate.outDir, name))), hashes[name]);
  }

  const input = await makeInput(candidate.root, 4096);
  const rootA = path.join(candidate.root, "repro-a");
  const rootB = path.join(candidate.root, "repro-b");
  await fs.mkdir(rootA);
  await fs.mkdir(rootB);
  const a = await buildCandidateAt(input, path.join(rootA, "out"), rootA);
  const b = await buildCandidateAt(input, path.join(rootB, "out"), rootB);
  for (const name of ["audio-engine-1.0.0-darwin-arm64.candidate.tar.gz", "candidate.json", "SHA256SUMS", "COMPLETE"]) {
    assert.equal(sha256(await fs.readFile(path.join(a.outDir, name))), sha256(await fs.readFile(path.join(b.outDir, name))));
  }
});

test("A06/A07/B08: 残缺目录不接管、输入 pin 不符、归档名竞争不覆盖外来文件", async (t) => {
  const candidate = await buildCandidate(t);
  const half = path.join(candidate.root, "half-dir");
  await fs.mkdir(half);
  await fs.writeFile(path.join(half, "partial.bin"), "half");
  const again = await runCli([
    "build", "--input", candidate.input.file, "--input-sha256", candidate.input.sha256,
    "--input-size", String(candidate.input.size), "--version", "1.0.0",
    "--platform", "darwin", "--arch", "arm64", "--out-dir", half,
  ]);
  assert.equal(again.code, 4, again.stderr);
  assert.equal(again.json.code, "CANDIDATE_OUTPUT_EXISTS");
  assert.equal(await fs.readFile(path.join(half, "partial.bin"), "utf8"), "half");
  assert.deepEqual((await fs.readdir(half)).sort(), ["partial.bin"]);

  const mismatch = path.join(candidate.root, "pin-out");
  const bad = await runCli([
    "build", "--input", candidate.input.file, "--input-sha256", "0".repeat(64),
    "--input-size", String(candidate.input.size), "--version", "1.0.0",
    "--platform", "darwin", "--arch", "arm64", "--out-dir", mismatch,
  ]);
  assert.equal(bad.code, 3, bad.stderr);
  assert.equal(bad.json.code, "CANDIDATE_INPUT_PIN_MISMATCH");
  assert.equal(await fs.stat(path.join(mismatch, "COMPLETE")).catch(() => null), null);
  assert.equal((await readJson(path.join(mismatch, "FAILED.json"))).complete, false);

  const preload = await writePreload(candidate.root);
  const raced = path.join(candidate.root, "race-out");
  const race = await runCliWithPreload(BUILD_ARGS(candidate.input, raced), preload, "race-archive");
  assert.equal(race.code, 4, race.stderr);
  assert.equal(race.json.code, "CANDIDATE_OUTPUT_EXISTS");
  assert.equal(await fs.readFile(path.join(raced, "audio-engine-1.0.0-darwin-arm64.candidate.tar.gz"), "utf8"), "FOREIGN");
});

test("B03/B09/B05: FIFO 立即拒绝、超 256 MiB 不读、读中输入被改 exit 3", async (t) => {
  const root = await makeRoot(t);
  const fifo = path.join(root, "input.fifo");
  await execFileAsync("mkfifo", [fifo]);
  const fifoResult = await runCli([
    "build", "--input", fifo, "--input-sha256", "0".repeat(64), "--input-size", "1",
    "--version", "1.0.0", "--platform", "darwin", "--arch", "arm64",
    "--out-dir", path.join(root, "fifo-out"),
  ]);
  assert.equal(fifoResult.code, 3, fifoResult.stderr);
  assert.equal(fifoResult.json.code, "CANDIDATE_INPUT_UNSAFE");

  const huge = path.join(root, "huge.bin");
  await fs.writeFile(huge, "x");
  await fs.truncate(huge, 256 * MiB + 1);
  const hugeResult = await runCli([
    "build", "--input", huge, "--input-sha256", "0".repeat(64), "--input-size", String(256 * MiB + 1),
    "--version", "1.0.0", "--platform", "darwin", "--arch", "arm64",
    "--out-dir", path.join(root, "huge-out"),
  ]);
  assert.equal(hugeResult.code, 3, hugeResult.stderr);
  assert.equal(hugeResult.json.code, "CANDIDATE_INPUT_TOO_LARGE");
  assert.equal(await fs.stat(path.join(root, "huge-out", "COMPLETE")).catch(() => null), null);

  const input = await makeInput(root, 8192);
  const preload = await writePreload(root);
  const changed = await runCliWithPreload(BUILD_ARGS(input, path.join(root, "changed-out")), preload, "input-append");
  assert.equal(changed.code, 3, changed.stderr);
  assert.equal(changed.json.code, "CANDIDATE_INPUT_CHANGED");
  assert.equal(await fs.stat(path.join(root, "changed-out", "COMPLETE")).catch(() => null), null);
});

/* ───────────────────── C：恶意/畸形归档与描述 ───────────────────── */

test("C01-C05: 重复/额外/PAX/链接/穿越成员统一 exit 5", async (t) => {
  const candidate = await buildCandidate(t);
  const input = await fs.readFile(candidate.input.file);
  const cases = [
    ["duplicate", await makeTar([
      { name: "audio-analyze", data: input, mode: 0o755 },
      { name: "audio-analyze", data: input, mode: 0o755 },
    ])],
    ["hidden-extra", await makeTar([
      { name: "._audio-analyze", data: Buffer.alloc(163, 0x41), mode: 0o755 },
      { name: "audio-analyze", data: input, mode: 0o755 },
    ])],
    ["pax", await makeTar([
      { name: "audio-analyze", data: input, mode: 0o755, pax: { path: "audio-analyze" } },
    ])],
    ["symlink", await makeTar([
      { name: "audio-analyze", type: "symlink", linkname: "/etc/passwd", mode: 0o755 },
    ])],
    ["traversal", await makeTar([
      { name: "../evil", data: input, mode: 0o755 },
    ])],
  ];
  for (const [name, buffer] of cases) {
    const dir = await cloneOut(candidate, `c-${name}`);
    await fs.writeFile(path.join(dir, candidate.archiveName), buffer);
    await syncOuter(dir);
    const result = await expectVerifyCode(dir, 5);
    assert.equal(result.code, "CANDIDATE_ARCHIVE_INVALID", `${name}: ${JSON.stringify(result)}`);
  }
});

test("C06/C10: 成员截断与非零 padding 统一 exit 5", async (t) => {
  const candidate = await buildCandidate(t, { size: 1000 });
  const raw = gunzipSync(await fs.readFile(candidate.archive));
  const truncated = await cloneOut(candidate, "c-truncated-member");
  await fs.writeFile(path.join(truncated, candidate.archiveName), gzipSync(raw.subarray(0, 512 + 900)));
  await syncOuter(truncated);
  const r1 = await expectVerifyCode(truncated, 5);
  assert.equal(r1.code, "CANDIDATE_ARCHIVE_INVALID");

  const dirty = Buffer.from(raw);
  dirty[512 + 1000] = 0x7f; // 1000 → padding 24 B，首字节非零
  const padded = await cloneOut(candidate, "c-nonzero-padding");
  await fs.writeFile(path.join(padded, candidate.archiveName), gzipSync(dirty));
  await syncOuter(padded);
  const r2 = await expectVerifyCode(padded, 5);
  assert.equal(r2.code, "CANDIDATE_ARCHIVE_INVALID");
});

test("C11/C12: 描述额外字段/类型错 6，归档硬上限 5 且不整读", async (t) => {
  const candidate = await buildCandidate(t);
  const extra = await cloneOut(candidate, "c-extra-field");
  const description = await readJson(path.join(extra, "candidate.json"));
  description.extra = true;
  await writeJson(path.join(extra, "candidate.json"), description);
  assert.equal((await expectVerifyCode(extra, 6)).code, "CANDIDATE_DESCRIPTION_INVALID");

  const wrongType = await cloneOut(candidate, "c-wrong-type");
  const description2 = await readJson(path.join(wrongType, "candidate.json"));
  description2.format.members = "1";
  await writeJson(path.join(wrongType, "candidate.json"), description2);
  assert.equal((await expectVerifyCode(wrongType, 6)).code, "CANDIDATE_DESCRIPTION_INVALID");

  const big = await cloneOut(candidate, "c-oversize");
  const bigPath = path.join(big, candidate.archiveName);
  await fs.truncate(bigPath, 130 * MiB + 1);
  const result = await expectVerifyCode(big, 5);
  assert.equal(result.code, "CANDIDATE_ARCHIVE_TOO_LARGE");
});

/* ───────────────────── D/K：写失败、有界超时与 cleanup unknown ───────────────────── */

test("D01/D02/D05: 归档/描述写失败 7，close 不 settle → 9", async (t) => {
  const root = await makeRoot(t);
  const input = await makeInput(root, 4096);
  const preload = await writePreload(root);

  const writeFail = await runCliWithPreload(BUILD_ARGS(input, path.join(root, "d01")), preload, "fail-write");
  assert.equal(writeFail.code, 7, writeFail.stderr);
  assert.equal(writeFail.json.code, "CANDIDATE_WRITE_FAILED");
  assert.equal(await fs.stat(path.join(root, "d01", "COMPLETE")).catch(() => null), null);
  assert.equal((await readJson(path.join(root, "d01", "FAILED.json"))).code, "CANDIDATE_WRITE_FAILED");

  const descFail = await runCliWithPreload(BUILD_ARGS(input, path.join(root, "d02")), preload, "fail-description");
  assert.equal(descFail.code, 7, descFail.stderr);
  assert.equal(descFail.json.code, "CANDIDATE_WRITE_FAILED");
  assert.ok((await fs.stat(path.join(root, "d02", "audio-engine-1.0.0-darwin-arm64.candidate.tar.gz"))).size > 0);
  assert.equal(await fs.stat(path.join(root, "d02", "COMPLETE")).catch(() => null), null);

  const unknown = await runCliWithPreload(BUILD_ARGS(input, path.join(root, "d05")), preload, "stall-write-close");
  assert.equal(unknown.code, 9, unknown.stderr);
  assert.equal(unknown.json.code, "CANDIDATE_CLEANUP_UNKNOWN");
  assert.equal(unknown.json.cleanup, "unknown");
  assert.ok(unknown.json.inventory.includes("FAILED.json"));
  assert.ok(unknown.elapsed < 5000);
});

test("K01/K02/K04: 读/写 stall 超时 8，settle 不了才 9，共用 2 s 预算", async (t) => {
  const root = await makeRoot(t);
  const input = await makeInput(root, 4096);
  const preload = await writePreload(root);

  const k01a = await runCliWithPreload(BUILD_ARGS(input, path.join(root, "k01a")), preload, "stall-read");
  assert.equal(k01a.code, 8, k01a.stderr);
  assert.equal(k01a.json.code, "CANDIDATE_TIMEOUT");
  assert.equal(k01a.json.cleanup, "done");
  assert.equal(k01a.json.stage, "input");
  assert.ok(k01a.elapsed < 5000, `elapsed ${k01a.elapsed}`);
  assert.equal(k01a.stdout.trim(), "");

  const k01b = await runCliWithPreload(BUILD_ARGS(input, path.join(root, "k01b")), preload, "stall-read-close");
  assert.equal(k01b.code, 9, k01b.stderr);
  assert.equal(k01b.json.code, "CANDIDATE_CLEANUP_UNKNOWN");
  assert.equal(k01b.json.cleanup, "unknown");
  assert.ok(k01b.elapsed < 6000, `elapsed ${k01b.elapsed}`);
  assert.equal(k01b.stdout.trim(), "");

  const k02a = await runCliWithPreload(BUILD_ARGS(input, path.join(root, "k02a")), preload, "stall-write");
  assert.equal(k02a.code, 8, k02a.stderr);
  assert.equal(k02a.json.cleanup, "done");
  assert.equal(k02a.json.stage, "write");

  const k02b = await runCliWithPreload(BUILD_ARGS(input, path.join(root, "k02b")), preload, "stall-write-close");
  assert.equal(k02b.code, 9, k02b.stderr);
  assert.equal(k02b.json.cleanup, "unknown");

  // K04：读+写同时不 settle，仍只花一次 2 s 共同清理，不叠加成 4 s。
  const k04 = await runCliWithPreload(BUILD_ARGS(input, path.join(root, "k04")), preload, "stall-all");
  assert.equal(k04.code, 9, k04.stderr);
  assert.ok(k04.elapsed < 6000, `elapsed ${k04.elapsed}`);
});

test("K05/K06: SIGTERM 可 settle → 8，verify stall → 8，且 stdout 无成功对象", async (t) => {
  const root = await makeRoot(t);
  const input = await makeInput(root, 4096);
  const preload = await writePreload(root);
  const cancelled = await runCliSignal(BUILD_ARGS(input, path.join(root, "k05")), preload, "stall-read");
  assert.equal(cancelled.code, 8, cancelled.stderr);
  assert.equal(cancelled.json.code, "CANDIDATE_CANCELLED");
  assert.equal(cancelled.json.cleanup, "done");
  assert.equal(cancelled.stdout.trim(), "");
  assert.ok(cancelled.elapsed < 5000);

  const candidate = await buildCandidate(t);
  const verifyTimeout = await runCliWithPreload(
    ["verify", "--dir", candidate.outDir],
    preload,
    "stall-read",
  );
  assert.equal(verifyTimeout.code, 8, verifyTimeout.stderr);
  assert.equal(verifyTimeout.json.code, "CANDIDATE_TIMEOUT");
  assert.equal(verifyTimeout.stdout.trim(), "");
});

/* ───────────────────── F：保护源 hash 与只读边界 ───────────────────── */

test("F01/E04: 保护源与依赖 hash 未被本轮改动", async (t) => {
  const expected = {
    "server/audio-engine.mjs": "73df42f8ef25ccd0c201d56335f04cc2dad73928062accb99d02c2574af6fa38",
    "tests/audio-engine-installer.test.mjs": "4c67e546815f23fe1a45805af7d5768bb12ab6f733a080f2b514e19d458c281c",
    "tests/audio-engine-fixtures.mjs": "ad08ff4ed2cecb946cf35cd8007459c86f78ff7e971e50ab4c7f5a2420ac2230",
    "package.json": "64bcdd6fc2f4d129e136e9e878e5983c22f4e0fdb73103a8debbfb3ee35d5729",
    "package-lock.json": "08106701590aa3a6236a29cc341047b80ca49fd8200336989c8b32d3b613f26b",
    "server/native/audio-executor-launcher.c": "9ff0e66713c22e1a29d2cab9b7c746b6fa30eeeb360e084385a951b0da898e13",
    "tests/audio-executor-launcher-build.test.mjs": "2c23b855dba28a88f5627e2f77e0caebc92876f697a838dbaa8f5cd9f335f01e",
    "node_modules/tar-stream/package.json": "bf26c92d0b2d3b865681bac5cf3bca4cd405e33fcb47f45216899aaed4f81010",
  };
  for (const [file, hash] of Object.entries(expected)) {
    assert.equal(sha256(await fs.readFile(path.join(PROJECT, file))), hash, file);
  }
});

test("B02/B04: 目录与字符设备输入 exit 3，且不打开读", async (t) => {
  const root = await makeRoot(t);
  for (const [name, target] of [["directory", root], ["device", "/dev/null"]]) {
    const result = await runCli([
      "build", "--input", target, "--input-sha256", "0".repeat(64), "--input-size", "1",
      "--version", "1.0.0", "--platform", "darwin", "--arch", "arm64",
      "--out-dir", path.join(root, `out-${name}`),
    ]);
    assert.equal(result.code, 3, `${name}: ${result.stderr}`);
    assert.equal(result.json.code, "CANDIDATE_INPUT_UNSAFE");
  }
});

test("G07/G08: 第二非空 gzip 成员与 1/512 B 尾随 junk 均 exit 5", async (t) => {
  const candidate = await buildCandidate(t);
  const base = await fs.readFile(candidate.archive);
  const cases = [
    ["second-nonempty", Buffer.concat([base, gzipSync(Buffer.from("second-member"))])],
    ["junk-1", Buffer.concat([base, Buffer.from([0x00])])],
    ["junk-512", Buffer.concat([base, Buffer.alloc(512, 0x5a)])],
  ];
  for (const [name, buffer] of cases) {
    const dir = await cloneOut(candidate, `g07-${name}`);
    await fs.writeFile(path.join(dir, candidate.archiveName), buffer);
    await syncOuter(dir);
    const result = await expectVerifyCode(dir, 5);
    assert.equal(result.code, "CANDIDATE_ARCHIVE_INVALID", name);
  }
});

test("I03a/I03b: 读中同 inode 增长/缩短 → 6 ARCHIVE_CHANGED", async (t) => {
  const root = await makeRoot(t);
  const input = await makeInput(root, 65536);
  const preload = await writePreload(root);
  const a = await buildCandidateAt(input, path.join(root, "out-a"), root);
  const b = await buildCandidateAt(input, path.join(root, "out-b"), root);
  const grow = await runCliWithPreload(["verify", "--dir", a.outDir], preload, "archive-append");
  assert.equal(grow.code, 6, grow.stderr);
  assert.equal(grow.json.code, "CANDIDATE_ARCHIVE_CHANGED");
  const shrink = await runCliWithPreload(["verify", "--dir", b.outDir], preload, "archive-truncate");
  assert.equal(shrink.code, 6, shrink.stderr);
  assert.equal(shrink.json.code, "CANDIDATE_ARCHIVE_CHANGED");
});

test("I04a/I04b: 描述未读完变异 → 6；读满+EOF 后变异 → 0 且用已读 buffer", async (t) => {
  const root = await makeRoot(t);
  const input = await makeInput(root, 4096);
  const preload = await writePreload(root);
  const a = await buildCandidateAt(input, path.join(root, "out-a"), root);
  const oldDescriptionSha = sha256(await fs.readFile(a.description));
  const archive = await fs.readFile(a.archive);
  const partial = await runCliWithPreload([
    "verify", "--archive", a.archive, "--description", a.description,
    "--expect-archive-sha256", sha256(archive), "--expect-archive-size", String(archive.length),
    "--expect-description-sha256", oldDescriptionSha,
  ], preload, "desc-partial");
  assert.equal(partial.code, 6, partial.stderr);
  assert.equal(partial.json.code, "CANDIDATE_DESCRIPTION_MISMATCH");

  const b = await buildCandidateAt(input, path.join(root, "out-b"), root);
  const oldB = sha256(await fs.readFile(b.description));
  const archiveB = await fs.readFile(b.archive);
  const after = await runCliWithPreload([
    "verify", "--archive", b.archive, "--description", b.description,
    "--expect-archive-sha256", sha256(archiveB), "--expect-archive-size", String(archiveB.length),
    "--expect-description-sha256", oldB,
  ], preload, "desc-after-eof");
  assert.equal(after.code, 0, after.stderr);
  assert.equal(after.json.description.sha256, oldB);
});

test("J12: 目录 fsync 注入失败 → build 0 + dirFsync failed，verify-dir 仍按实际内容 0", async (t) => {
  const root = await makeRoot(t);
  const input = await makeInput(root, 4096);
  const preload = await writePreload(root);
  const outDir = path.join(root, "j12");
  const built = await runCliWithPreload(BUILD_ARGS(input, outDir), preload, "dir-fsync-fail");
  assert.equal(built.code, 0, built.stderr);
  assert.equal(built.json.complete.contentComplete, false);
  assert.equal(built.json.complete.contentVerifiedBy, null);
  assert.equal(built.json.dirFsync, "failed");
  assert.equal(built.json.complete.durable, "not-claimed");
  const verified = await runCli(["verify", "--dir", outDir]);
  assert.equal(verified.code, 0, verified.stderr);
  assert.equal(verified.json.complete.contentComplete, true);
  assert.equal(verified.json.complete.contentVerifiedBy, "verify-dir");
});

/* ───────────────────── #0263 P2 返工定向回归 ───────────────────── */

test("P2-1: makeRoot after 零新 FS 采集；替换根/外来字节仍保留", async () => {
  const self = await fs.readFile(fileURLToPath(import.meta.url), "utf8");
  const start = self.indexOf("async function makeRoot(t)");
  const end = self.indexOf("async function makeInput(");
  assert.ok(start > 0 && end > start);
  let counting = false;
  const calls = [];
  const fsProxy = new Proxy(fs, {
    get(target, property) {
      const value = target[property];
      if (counting && typeof value === "function") {
        return (...args) => {
          calls.push(String(property));
          return value.apply(target, args);
        };
      }
      return value;
    },
  });
  const makeRootProbe = new Function(
    "fs",
    "path",
    "os",
    `${self.slice(start, end)}; return makeRoot;`,
  )(fsProxy, path, os);
  let after;
  const diagnostics = [];
  const probeRoot = await makeRootProbe({
    after(callback) {
      after = callback;
    },
    diagnostic(message) {
      diagnostics.push(String(message));
    },
  });
  const moved = `${probeRoot}-reviewer-original`;
  await fs.rename(probeRoot, moved);
  await fs.mkdir(probeRoot);
  const foreign = path.join(probeRoot, "foreign-synthetic.txt");
  const foreignBytes = "reviewer foreign synthetic bytes";
  await fs.writeFile(foreign, foreignBytes);
  counting = true;
  await after();
  counting = false;
  assert.deepEqual(calls, [], `after 不应发起任何 FS 调用: ${calls.join(",")}`);
  assert.equal(await fs.readFile(foreign, "utf8"), foreignBytes);
  assert.equal((await fs.lstat(moved)).isDirectory(), true);
  const note = diagnostics.join("\n");
  assert.match(note, /current identity\/contents UNKNOWN/);
  assert.match(note, /no FS inspection, not deleted/);
  // 本探针自己的两个根也按保守策略保留；不删除 reviewer/历史根。
  assert.equal((await fs.lstat(moved)).isDirectory(), true);
});

test("P2-2: 元数据/诊断 I/O 不再绕过唯一 2 s 收尾，迟到 handle 计入", async (t) => {
  const root = await makeRoot(t);
  const input = await makeInput(root, 4096);
  const preload = await writePreload(root);
  const badPin = { ...input, sha256: "0".repeat(64) };

  const metadataWrite = await runCliWithPreload(
    BUILD_ARGS(input, path.join(root, "p2-metadata-write")),
    preload,
    "p2-stall-metadata-write",
  );
  assert.equal(metadataWrite.code, 9, metadataWrite.stderr);
  assert.equal(metadataWrite.json.code, "CANDIDATE_CLEANUP_UNKNOWN");
  assert.equal(metadataWrite.json.cleanup, "unknown");
  assert.equal(metadataWrite.stdout.trim(), "");
  assert.ok(metadataWrite.elapsed < 3500, `elapsed ${metadataWrite.elapsed}`);

  const diagnosticWrite = await runCliWithPreload(
    BUILD_ARGS(badPin, path.join(root, "p2-diagnostic-write")),
    preload,
    "p2-stall-diagnostic-write",
  );
  assert.equal(diagnosticWrite.code, 9, diagnosticWrite.stderr);
  assert.equal(diagnosticWrite.json.code, "CANDIDATE_CLEANUP_UNKNOWN");
  assert.equal(diagnosticWrite.stdout.trim(), "");
  assert.ok(diagnosticWrite.elapsed < 3500, `elapsed ${diagnosticWrite.elapsed}`);

  const metadataSync = await runCliWithPreload(
    BUILD_ARGS(input, path.join(root, "p2-metadata-sync")),
    preload,
    "p2-stall-metadata-sync",
  );
  assert.equal(metadataSync.code, 9, metadataSync.stderr);
  assert.equal(metadataSync.json.code, "CANDIDATE_CLEANUP_UNKNOWN");
  assert.ok(metadataSync.elapsed < 3500, `elapsed ${metadataSync.elapsed}`);

  const readdirStall = await runCliWithPreload(
    BUILD_ARGS(badPin, path.join(root, "p2-readdir-stall")),
    preload,
    "p2-stall-readdir",
  );
  assert.equal(readdirStall.code, 9, readdirStall.stderr);
  assert.equal(readdirStall.json.inventoryUnknown, true);
  assert.ok(readdirStall.elapsed < 3500, `elapsed ${readdirStall.elapsed}`);

  const openStall = await runCliWithPreload(
    BUILD_ARGS(input, path.join(root, "p2-open-stall")),
    preload,
    "p2-stall-open",
  );
  assert.equal(openStall.code, 9, openStall.stderr);
  assert.equal(openStall.json.code, "CANDIDATE_CLEANUP_UNKNOWN");
  assert.ok(openStall.elapsed < 3500, `elapsed ${openStall.elapsed}`);

  // close 成功也不能把永久未 settle 的 read 伪造成 done：只能 exit 9 unknown。
  const readForever = await runCliWithPreload(
    BUILD_ARGS(input, path.join(root, "p2-read-forever")),
    preload,
    "p2-stall-read-forever",
  );
  assert.equal(readForever.code, 9, readForever.stderr);
  assert.equal(readForever.json.code, "CANDIDATE_CLEANUP_UNKNOWN");
  assert.ok(readForever.elapsed < 3500, `elapsed ${readForever.elapsed}`);

  // 迟到 open：work deadline 先到，但 2 s 收尾内 handle 返回并 close，可确认 done → 8。
  const slowOpen = await runCliWithPreload(
    BUILD_ARGS(input, path.join(root, "p2-slow-open")),
    preload,
    "p2-slow-open",
  );
  assert.equal(slowOpen.code, 8, slowOpen.stderr);
  assert.equal(slowOpen.json.code, "CANDIDATE_TIMEOUT");
  assert.equal(slowOpen.json.cleanup, "done");
  assert.ok(slowOpen.elapsed < 3000, `elapsed ${slowOpen.elapsed}`);

  // 迟到 rejection 只由收尾 guard 记账，不允许变成未处理拒绝/成功对象。
  const lateReject = await runCliWithPreload(
    BUILD_ARGS(input, path.join(root, "p2-late-reject")),
    preload,
    "p2-late-reject",
  );
  assert.equal(lateReject.code, 8, lateReject.stderr);
  assert.equal(lateReject.json.cleanup, "done");
  assert.equal(lateReject.stdout.trim(), "");

  // 非 ENOENT 的 inventory 观测失败必须 unknown，不能伪造成“空目录”。
  const eacces = await runCliWithPreload(
    BUILD_ARGS(badPin, path.join(root, "p2-readdir-eacces")),
    preload,
    "p2-readdir-eacces",
  );
  assert.equal(eacces.code, 3, eacces.stderr);
  assert.equal(eacces.json.inventoryUnknown, true);
});

test("P2-3: TarChecker 逐片消费成员，不累积整 member，结构错立即停止", async () => {
  const source = await fs.readFile(CLI, "utf8");
  const start = source.indexOf("function parseOctalField(");
  const end = source.indexOf("const CRC_TABLE =");
  assert.ok(start > 0 && end > start);
  const parserSource = source.slice(start, end);
  const TarChecker = new Function(
    "crypto",
    "MEMBER_NAME",
    "MAX_INPUT_BYTES",
    "roundUp512",
    "fail",
    `${parserSource}; return TarChecker;`,
  )(
    crypto,
    "audio-analyze",
    256 * MiB,
    (value) => Math.ceil(value / 512) * 512,
    (code) => Object.assign(new Error(code), { code }),
  );
  const require = createRequire(import.meta.url);
  const headers = require("tar-stream/headers.js");
  const memberBytes = 8 * MiB;
  const header = headers.encode({
    name: "audio-analyze",
    mode: 0o755,
    uid: 0,
    gid: 0,
    size: memberBytes,
    mtime: new Date(0),
    type: "file",
    uname: "",
    gname: "",
  });
  assert.equal(header.length, 512);

  const parser = new TarChecker();
  const digest = crypto.createHash("sha256");
  const chunk = Buffer.alloc(16 * 1024, 0x5a);
  parser.push(header);
  for (let i = 0; i < 128; i += 1) {
    parser.push(chunk);
    digest.update(chunk);
  }
  assert.equal(parser.buffer.length, 0);
  assert.equal(parser.state, "DATA");
  assert.equal(parser.error, null);
  assert.equal(parser.memberRemaining, memberBytes - 2 * MiB);
  assert.ok(parser.total <= 512 + 2 * MiB, `total ${parser.total}`);

  for (let fed = 2 * MiB; fed < memberBytes; fed += chunk.length) {
    parser.push(chunk);
    digest.update(chunk);
  }
  parser.push(Buffer.alloc(1024));
  const member = parser.finish();
  assert.equal(member.bytes, memberBytes);
  assert.equal(member.sha256, digest.digest("hex"));

  // 声明 1 KiB 后立刻喂 4 KiB 非零：进入 padding/end 即拒绝，不继续囤积。
  const bad = new TarChecker();
  bad.push(
    headers.encode({
      name: "audio-analyze",
      mode: 0o755,
      uid: 0,
      gid: 0,
      size: 1024,
      mtime: new Date(0),
      type: "file",
      uname: "",
      gname: "",
    }),
  );
  bad.push(Buffer.alloc(4096, 0x41));
  assert.ok(bad.error, "结构错误必须立即记录");
  assert.equal(bad.error.code, "ARCHIVE_INVALID");
  assert.equal(bad.buffer.length, 0);

  // 坏 header 后立刻喂 2 MiB：只消费 512 B header，不把正文囤进 buffer。
  const badHeader = Buffer.from(header);
  badHeader[0] = 0x42;
  const rejected = new TarChecker();
  rejected.push(badHeader);
  rejected.push(Buffer.alloc(2 * MiB, 0x41));
  assert.equal(rejected.total, 512);
  assert.equal(rejected.buffer.length, 0);
  assert.ok(rejected.error);
});

/* ───────────── #0267 P2：after 零新 FS 采集，只回显登记信息 ───────────── */

const ROOT_PROBE_SOURCE = String.raw`
const scenario = process.env.CAND_ROOT_SCENARIO;
const root = await makeRoot({
  after(callback) { globalThis.__after = callback; },
  diagnostic(message) { console.log("NOTE=" + message); },
});
const after = globalThis.__after;
const calls = [];
if (scenario === "no-fs-calls") {
  // 永不 settle 的观测替身：after 只要碰任一查询就会被外部 watchdog 抓住。
  for (const name of [
    "lstat", "stat", "readdir", "opendir", "realpath",
    "rm", "unlink", "rename", "access", "open",
  ]) {
    fs[name] = (...args) => {
      calls.push(name);
      return new Promise(() => {});
    };
  }
} else if (scenario === "readdir-5s") {
  // 独立审查原探针：readdir 延迟 5 s。after 不应调用它。
  fs.readdir = () => new Promise((resolve) => setTimeout(() => resolve([]), 5000));
} else if (scenario === "fixed-retain") {
  for (let index = 0; index < 20; index += 1) {
    await fs.writeFile(path.join(root, "entry-" + index + ".txt"), "x");
  }
}
const started = Date.now();
await after();
console.log("AFTER_MS=" + (Date.now() - started));
console.log("FS_CALLS=" + calls.length);
console.log("FS_CALL_NAMES=" + calls.join(","));
if (scenario === "fixed-retain") {
  console.log("FILES_AFTER=" + (await fs.readdir(root)).length);
}
console.log("ROOT=" + root);
`;

async function runRootProbe(scenario, watchdogMs = 2200) {
  const self = await fs.readFile(fileURLToPath(import.meta.url), "utf8");
  const start = self.indexOf("async function makeRoot(t)");
  const end = self.indexOf("async function makeInput(");
  assert.ok(start > 0 && end > start, "makeRoot helper must remain extractable");
  const code = `
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
${self.slice(start, end)}
${ROOT_PROBE_SOURCE}
`;
  const started = Date.now();
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CAND_ROOT_SCENARIO: scenario },
  });
  let stdout = "";
  let stderr = "";
  let killed = false;
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const timer = setTimeout(() => {
    killed = true;
    child.kill("SIGKILL");
  }, watchdogMs);
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  return { scenario, stdout, stderr, elapsed: Date.now() - started, killed, exit };
}

test("P2-4: after 零新 FS 采集；永不 settle 替身不被调用，真实子进程自然退出", async () => {
  const probes = {};
  for (const scenario of ["no-fs-calls", "readdir-5s", "fixed-retain"]) {
    probes[scenario] = await runRootProbe(scenario);
  }
  for (const [scenario, probe] of Object.entries(probes)) {
    assert.equal(probe.killed, false, `${scenario} 被外部 watchdog 杀掉: ${JSON.stringify(probe)}`);
    assert.equal(probe.exit.code, 0, `${scenario} 未自然退出: ${JSON.stringify(probe)}`);
    assert.equal(probe.exit.signal, null, `${scenario} 被信号终止: ${JSON.stringify(probe)}`);
    assert.match(probe.stdout, /ROOT=/, `${scenario} 未完成 after: ${JSON.stringify(probe)}`);
    assert.match(probe.stdout, /AFTER_MS=\d+/, `${scenario} 缺 after 计时: ${JSON.stringify(probe)}`);
    const afterMs = Number(probe.stdout.match(/AFTER_MS=(\d+)/)[1]);
    assert.ok(afterMs < 1000, `${scenario} after 超出记录预算: ${afterMs} ms`);
  }

  // 永不 settle 的 lstat/stat/readdir/opendir/read/realpath/rm/... 全部未被调用。
  assert.match(probes["no-fs-calls"].stdout, /FS_CALLS=0/);
  assert.match(probes["no-fs-calls"].stdout, /NOTE=.*current identity\/contents UNKNOWN/);
  assert.match(probes["no-fs-calls"].stdout, /NOTE=.*no FS inspection, not deleted/);

  // 原审查观察：readdir 延迟 5 s 不再被调用，after 立即完成且不杀子进程。
  assert.match(probes["readdir-5s"].stdout, /NOTE=.*current identity\/contents UNKNOWN/);
  assert.ok(probes["readdir-5s"].elapsed < 2000, `readdir-5s elapsed ${probes["readdir-5s"].elapsed}`);

  // 20 个文件一个不少；after 不枚举，仍明确 UNKNOWN。
  assert.match(probes["fixed-retain"].stdout, /FILES_AFTER=20/);
  assert.match(probes["fixed-retain"].stdout, /NOTE=.*current identity\/contents UNKNOWN/);
});

