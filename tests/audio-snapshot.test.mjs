/**
 * T-LOCAL-013B：有界源文件快照的隔离测试。
 *
 * 全部在临时目录内用小合成文件/FIFO；不读取真实素材、不联网、不启动引擎。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  AudioSnapshotError,
  assertSourceUnchanged,
  createSnapshot,
} from "../server/audio-snapshot.mjs";

const execFileAsync = promisify(execFile);
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

async function tempBase(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-snapshot-")));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makeRoot(base) {
  const root = path.join(base, "media");
  await fs.mkdir(root, { recursive: true });
  return root;
}

function args(base, root, source, extra = {}) {
  return {
    dataDir: path.join(base, "data"),
    rootPath: root,
    sourcePath: source,
    maxBytes: 1024 * 1024,
    jobId: "test-job",
    ...extra,
  };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof AudioSnapshotError, String(error));
    assert.equal(error.code, code, String(error));
    return true;
  });
}

async function modeOf(p) {
  return (await fs.stat(p)).mode & 0o777;
}

test("正常快照：流式 SHA256、0600/0700、原文件不变、只清理自有目录", async (t) => {
  const base = await tempBase(t);
  const root = await makeRoot(base);
  const source = path.join(root, "track.bin");
  const content = crypto.randomBytes(220 * 1024);
  await fs.writeFile(source, content);

  const snapshot = await createSnapshot(args(base, root, source));
  assert.equal(snapshot.bytes, content.length);
  assert.equal(snapshot.sha256, sha256(content));
  assert.equal(await modeOf(snapshot.dir), 0o700);
  assert.equal(await modeOf(snapshot.filePath), 0o600);
  assert.deepEqual(await fs.readFile(snapshot.filePath), content);
  assert.equal(snapshot.chunks >= 4, true, "64KiB 分块读取");
  assert.equal(await fs.readFile(source).then((b) => b.equals(content)), true, "原文件未被修改");
  assert.equal(await assertSourceUnchanged(snapshot), true);

  const sibling = path.join(path.dirname(snapshot.dir), "unknown-task");
  await fs.mkdir(sibling, { recursive: true });
  await fs.writeFile(path.join(sibling, "keep.txt"), "keep");
  await snapshot.cleanup();
  await assert.rejects(fs.lstat(snapshot.dir), /ENOENT/);
  assert.equal(await fs.readFile(path.join(sibling, "keep.txt"), "utf8"), "keep");
  await snapshot.cleanup(); // 幂等
});

test("短写：每块只落盘一半时循环写满，报告字节/hash 与副本一致", async (t) => {
  const base = await tempBase(t);
  const root = await makeRoot(base);
  const source = path.join(root, "short.bin");
  const content = crypto.randomBytes(128 * 1024 + 7);
  await fs.writeFile(source, content);

  const originalOpen = fs.open;
  fs.open = async (...openArgs) => {
    const handle = await originalOpen(...openArgs);
    if (path.basename(String(openArgs[0])) === "source.bin") {
      const originalWrite = handle.write.bind(handle);
      handle.write = (buffer, offset, length, ...rest) =>
        originalWrite(buffer, offset, Math.max(1, Math.floor(length / 2)), ...rest);
    }
    return handle;
  };
  t.after(() => {
    fs.open = originalOpen;
  });

  const snapshot = await createSnapshot(args(base, root, source));
  try {
    const actual = await fs.readFile(snapshot.filePath);
    assert.equal(actual.length, snapshot.bytes, "不得报告未实际写入的字节");
    assert.equal(sha256(actual), snapshot.sha256, "摘要必须对应实际副本");
    assert.deepEqual(actual, content);
  } finally {
    await snapshot.cleanup();
  }
});

test("零进度写：受控 SNAPSHOT_FAILED 并清理自有目录", async (t) => {
  const base = await tempBase(t);
  const root = await makeRoot(base);
  const source = path.join(root, "zero.bin");
  await fs.writeFile(source, crypto.randomBytes(80 * 1024));

  let injected = false;
  const originalOpen = fs.open;
  fs.open = async (...openArgs) => {
    const handle = await originalOpen(...openArgs);
    if (path.basename(String(openArgs[0])) === "source.bin") {
      const originalWrite = handle.write.bind(handle);
      handle.write = async (buffer, offset, length, ...rest) => {
        if (!injected) {
          injected = true;
          return { bytesWritten: 0 };
        }
        return originalWrite(buffer, offset, length, ...rest);
      };
    }
    return handle;
  };
  t.after(() => {
    fs.open = originalOpen;
  });

  await expectCode(createSnapshot(args(base, root, source)), "SNAPSHOT_FAILED");
  const left = await fs.readdir(path.join(base, "data", "audio-jobs")).catch(() => []);
  assert.deepEqual(left, [], "零进度失败后不留下自有任务目录");
});

test("成功前核对副本实际字节数：副本少 1 字节即 SNAPSHOT_FAILED", async (t) => {
  const base = await tempBase(t);
  const root = await makeRoot(base);
  const source = path.join(root, "sizecheck.bin");
  await fs.writeFile(source, crypto.randomBytes(96 * 1024));

  const originalOpen = fs.open;
  fs.open = async (...openArgs) => {
    const handle = await originalOpen(...openArgs);
    if (path.basename(String(openArgs[0])) === "source.bin") {
      const originalStat = handle.stat.bind(handle);
      handle.stat = async () => {
        const stat = await originalStat();
        return { size: Math.max(0, stat.size - 1) };
      };
    }
    return handle;
  };
  t.after(() => {
    fs.open = originalOpen;
  });

  await expectCode(createSnapshot(args(base, root, source)), "SNAPSHOT_FAILED");
  const left = await fs.readdir(path.join(base, "data", "audio-jobs")).catch(() => []);
  assert.deepEqual(left, []);
});

test("空文件策略：允许 0 字节普通文件，hash 为 sha256(空)", async (t) => {
  const base = await tempBase(t);
  const root = await makeRoot(base);
  const source = path.join(root, "empty.wav");
  await fs.writeFile(source, Buffer.alloc(0));
  const snapshot = await createSnapshot(args(base, root, source));
  assert.equal(snapshot.bytes, 0);
  assert.equal(snapshot.sha256, sha256(Buffer.alloc(0)));
  await snapshot.cleanup();
});

test("边界：根外、同名前缀目录、逃逸链接、目录、最终符号链接都拒绝", async (t) => {
  const base = await tempBase(t);
  const root = await makeRoot(base);
  const outside = path.join(base, "media-evil");
  await fs.mkdir(outside, { recursive: true });
  const secret = path.join(outside, "secret.bin");
  await fs.writeFile(secret, "secret");

  await expectCode(createSnapshot(args(base, root, secret)), "SOURCE_OUTSIDE_ROOT");

  const escape = path.join(root, "escape.bin");
  await fs.symlink(secret, escape);
  await expectCode(createSnapshot(args(base, root, escape)), "SOURCE_OUTSIDE_ROOT");

  const dir = path.join(root, "folder");
  await fs.mkdir(dir);
  await expectCode(createSnapshot(args(base, root, dir)), "SOURCE_NOT_REGULAR");

  const inside = path.join(root, "real.bin");
  await fs.writeFile(inside, "abc");
  const link = path.join(root, "link.bin");
  await fs.symlink(inside, link);
  await expectCode(createSnapshot(args(base, root, link)), "SOURCE_NOT_REGULAR");
});

test("FIFO：直接拒绝；验证后被换成 FIFO 也不会挂死", async (t) => {
  const base = await tempBase(t);
  const root = await makeRoot(base);
  const fifo = path.join(root, "pipe");
  await execFileAsync("mkfifo", [fifo]);
  await expectCode(createSnapshot(args(base, root, fifo)), "SOURCE_NOT_REGULAR");

  const source = path.join(root, "race.bin");
  await fs.writeFile(source, crypto.randomBytes(96 * 1024));
  const started = Date.now();
  await expectCode(
    createSnapshot(
      args(base, root, source, {
        hooks: {
          async beforeOpen() {
            await fs.rm(source);
            await execFileAsync("mkfifo", [source]);
          },
        },
      }),
    ),
    "SOURCE_NOT_REGULAR",
  );
  assert.ok(Date.now() - started < 3000, "O_NONBLOCK 打开 FIFO 不应挂起");
});

test("打开前被换成另一个普通文件：fstat 身份不一致，SOURCE_CHANGED", async (t) => {
  const base = await tempBase(t);
  const root = await makeRoot(base);
  const source = path.join(root, "swap.bin");
  const replacement = path.join(root, "replacement.bin");
  await fs.writeFile(source, "original-content");
  await fs.writeFile(replacement, "replacement!!!");

  await expectCode(
    createSnapshot(
      args(base, root, source, {
        hooks: {
          async beforeOpen() {
            await fs.rename(replacement, source);
          },
        },
      }),
    ),
    "SOURCE_CHANGED",
  );
});

test("复制中增长/同尺寸改写/替换：SOURCE_CHANGED 且自有副本清理", async (t) => {
  const base = await tempBase(t);
  const root = await makeRoot(base);

  const growth = path.join(root, "growth.bin");
  await fs.writeFile(growth, crypto.randomBytes(160 * 1024));
  await expectCode(
    createSnapshot(
      args(base, root, growth, {
        hooks: {
          async afterChunk({ chunks }) {
            if (chunks === 1) await fs.appendFile(growth, Buffer.alloc(4096));
          },
        },
      }),
    ),
    "SOURCE_CHANGED",
  );

  const rewrite = path.join(root, "rewrite.bin");
  await fs.writeFile(rewrite, Buffer.alloc(160 * 1024, 1));
  await expectCode(
    createSnapshot(
      args(base, root, rewrite, {
        hooks: {
          async afterChunk({ chunks }) {
            if (chunks === 1) {
              await fs.writeFile(rewrite, Buffer.alloc(160 * 1024, 2));
              const now = new Date();
              await fs.utimes(rewrite, now, now);
            }
          },
        },
      }),
    ),
    "SOURCE_CHANGED",
  );

  const replace = path.join(root, "replace.bin");
  const next = path.join(root, "next.bin");
  await fs.writeFile(replace, Buffer.alloc(160 * 1024, 3));
  await fs.writeFile(next, Buffer.alloc(160 * 1024, 4));
  await expectCode(
    createSnapshot(
      args(base, root, replace, {
        hooks: {
          async afterChunk({ chunks }) {
            if (chunks === 1) await fs.rename(next, replace);
          },
        },
      }),
    ),
    "SOURCE_CHANGED",
  );

  const jobs = path.join(base, "data", "audio-jobs");
  const left = await fs.readdir(jobs).catch(() => []);
  assert.deepEqual(left, [], "失败快照不应留下任务目录");
});

test("超量、取消与清理归属", async (t) => {
  const base = await tempBase(t);
  const root = await makeRoot(base);
  const source = path.join(root, "big.bin");
  await fs.writeFile(source, crypto.randomBytes(32 * 1024));
  await expectCode(
    createSnapshot(args(base, root, source, { maxBytes: 1024 })),
    "INPUT_LIMIT_EXCEEDED",
  );

  const controller = new AbortController();
  await expectCode(
    createSnapshot(
      args(base, root, source, {
        signal: controller.signal,
        maxBytes: 1024 * 1024,
        hooks: {
          async afterChunk({ chunks }) {
            if (chunks === 1) controller.abort();
          },
        },
      }),
    ),
    "CANCELLED",
  );

  const ok = await createSnapshot(args(base, root, source));
  await fs.writeFile(path.join(ok.dir, ".owner.json"), JSON.stringify({ token: "not-mine" }));
  await expectCode(ok.cleanup(), "CLEANUP_FAILED");
  assert.ok(await fs.lstat(ok.dir), "标记不匹配时不得删除目录");
  await fs.rm(ok.dir, { recursive: true, force: true });
});

test("marker 部分写入后 ENOSPC：安全回收自有残留，不把未写完的标记当成功", async (t) => {
  const base = await tempBase(t);
  const root = await makeRoot(base);
  const source = path.join(root, "marker-partial.bin");
  await fs.writeFile(source, crypto.randomBytes(96 * 1024));

  const originalWriteFile = fs.writeFile;
  let injected = false;
  fs.writeFile = async (file, ...rest) => {
    if (!injected && path.basename(String(file)) === ".owner.json") {
      injected = true;
      // 先真实写入半段标记，再模拟磁盘满：markerWritten 仍为 false。
      await originalWriteFile(file, "{partial", { mode: 0o600, flag: "wx" });
      throw Object.assign(new Error("synthetic disk-full"), { code: "ENOSPC" });
    }
    return originalWriteFile(file, ...rest);
  };
  t.after(() => {
    fs.writeFile = originalWriteFile;
  });

  await expectCode(createSnapshot(args(base, root, source)), "SNAPSHOT_FAILED");
  assert.equal(injected, true);
  const jobs = path.join(base, "data", "audio-jobs");
  const left = await fs.readdir(jobs).catch(() => []);
  assert.deepEqual(left.filter((name) => name.startsWith("job-")), [], "半段 marker 也应安全回收");
});

test("marker 部分写入且 rmdir 失败：CLEANUP_FAILED 并保留残留目录", async (t) => {
  const base = await tempBase(t);
  const root = await makeRoot(base);
  const source = path.join(root, "marker-rmdir.bin");
  await fs.writeFile(source, crypto.randomBytes(96 * 1024));
  const jobs = path.join(base, "data", "audio-jobs");

  const originalWriteFile = fs.writeFile;
  const originalRmdir = fs.rmdir;
  let injected = false;
  fs.writeFile = async (file, ...rest) => {
    if (!injected && path.basename(String(file)) === ".owner.json") {
      injected = true;
      await originalWriteFile(file, "{partial", { mode: 0o600, flag: "wx" });
      throw Object.assign(new Error("synthetic disk-full"), { code: "ENOSPC" });
    }
    return originalWriteFile(file, ...rest);
  };
  fs.rmdir = async (p, ...rest) => {
    if (path.basename(String(p)).startsWith("job-")) {
      throw Object.assign(new Error("synthetic rmdir failure"), { code: "EACCES" });
    }
    return originalRmdir(p, ...rest);
  };
  t.after(() => {
    fs.writeFile = originalWriteFile;
    fs.rmdir = originalRmdir;
  });

  await expectCode(createSnapshot(args(base, root, source)), "CLEANUP_FAILED");
  assert.equal(injected, true);
  const residual = (await fs.readdir(jobs)).filter((name) => name.startsWith("job-"));
  assert.equal(residual.length, 1, "rmdir 失败时不得吞掉清理失败，保留自有残留");
  const residualDir = path.join(jobs, residual[0]);
  await fs.rm(residualDir, { recursive: true, force: true });
});
