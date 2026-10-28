/**
 * T-LOCAL-013I-LIFECYCLE-IMPL-001 round3：snapshot 创建全链 deadline 收敛、
 * 创建失败 unknown/pending 证据与 queue 保锁，以及 hashPlainFile 迟到 close
 * 失败证据的确定性合成测试。
 *
 * 只使用临时目录、1KiB 级合成文件、受控 gate 与自有 Node 进程；不读真实音频，
 * 不安装/运行发行引擎，不联网，不改限额。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { createSnapshot } from "../server/audio-snapshot.mjs";
import { AudioJobQueue } from "../server/audio-job-queue.mjs";
import { AudioExecutor, createAudioExecutorLauncherConfig } from "../server/audio-executor.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

async function snapshotFixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "t13i-r3-snapshot-")));
  const rootPath = path.join(base, "media");
  const dataDir = path.join(base, "data");
  const sourcePath = path.join(rootPath, "synthetic.bin");
  await fs.mkdir(rootPath);
  await fs.mkdir(dataDir);
  await fs.writeFile(sourcePath, Buffer.alloc(1024, 3));
  t.after(async () => {
    await fs.rm(base, { recursive: true, force: true }).catch(() => {});
  });
  return { base, rootPath, dataDir, sourcePath };
}

async function queueFixture(t, hooks, wallDeadlineMs) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "t13i-r3-queue-")));
  const media = path.join(base, "media");
  const dataDir = path.join(base, "data");
  await fs.mkdir(media);
  const sourcePath = path.join(media, "synthetic.bin");
  await fs.writeFile(sourcePath, Buffer.alloc(1024, 9));
  const asset = {
    assetId: "asset-one",
    kind: "music",
    sourcePath,
    rootPath: media,
    rootId: "root-one",
    online: true,
    trashed: false,
    retired: false,
    rootRetired: false,
    busy: false,
    assetGeneration: 1,
    libraryGeneration: 1,
    sourceGeneration: 1,
  };
  const queue = new AudioJobQueue({
    dataDir,
    resolveAsset: () => ({ ...asset }),
    execute: async () => Buffer.from("synthetic result"),
    hooks,
    wallDeadlineMs,
  });
  t.after(async () => {
    await queue.dispose().catch(() => {});
    await fs.rm(base, { recursive: true, force: true }).catch(() => {});
  });
  return { base, dataDir, queue };
}

test("snapshot source-open 受绝对 deadline：不等待 gate，迟到 fd 仍 close", async (t) => {
  const { base, rootPath, dataDir, sourcePath } = await snapshotFixture(t);
  const gate = deferred();
  const entered = deferred();
  const originalOpen = fs.open;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === sourcePath) {
      entered.resolve();
      await gate.promise;
    }
    return handle;
  };
  let error;
  try {
    const result = await Promise.race([
      createSnapshot({
        dataDir,
        rootPath,
        sourcePath,
        jobId: "synthetic",
        deadlineAtMs: performance.now() + 60,
      }).then(
        (value) => ({ value }),
        (caught) => ({ error: caught }),
      ),
      delay(500).then(() => ({ timeout: true })),
    ]);
    await entered.promise;
    await delay(150);
    assert.ok(result.error, "deadline 内必须以受控失败结束，不能等待 gate");
    assert.equal(result.error.code, "TIMEOUT");
    assert.equal(result.error.evidence.resourceUnknown, true);
    error = result.error;
  } finally {
    gate.resolve();
    fs.open = originalOpen;
  }
  await delay(30);
  assert.equal(error.evidence.closeFailed, undefined, "正常 late close 不应伪造失败证据");
  await fs.rm(base, { recursive: true, force: true }).catch(() => {});
});

test("snapshot job-mkdir / marker / output-open 迟到：保留 pending 证据且不并发删除", async (t) => {
  for (const kind of ["job-mkdir", "marker-write", "output-open"]) {
    const { base, rootPath, dataDir, sourcePath } = await snapshotFixture(t);
    const gate = deferred();
    const entered = deferred();
    const originalMkdir = fs.mkdir;
    const originalWriteFile = fs.writeFile;
    const originalOpen = fs.open;
    if (kind === "job-mkdir") {
      fs.mkdir = async (...args) => {
        if (String(args[0]).startsWith(path.join(dataDir, "audio-jobs", "job-"))) {
          entered.resolve();
          await gate.promise;
        }
        return originalMkdir(...args);
      };
    } else if (kind === "marker-write") {
      fs.writeFile = async (...args) => {
        if (path.basename(String(args[0])) === ".owner.json" && String(args[0]).includes("job-")) {
          entered.resolve();
          await gate.promise;
        }
        return originalWriteFile(...args);
      };
    } else {
      fs.open = async (...args) => {
        if (String(args[0]).includes("job-") && String(args[0]).endsWith("source.bin")) {
          entered.resolve();
          await gate.promise;
        }
        return originalOpen(...args);
      };
    }
    let error;
    try {
      const result = await Promise.race([
        createSnapshot({
          dataDir,
          rootPath,
          sourcePath,
          jobId: "synthetic",
          deadlineAtMs: performance.now() + 60,
        }).then(
          (value) => ({ value }),
          (caught) => ({ error: caught }),
        ),
        delay(500).then(() => ({ timeout: true })),
      ]);
      await entered.promise;
      await delay(150);
      assert.ok(result.error, `${kind} deadline 内必须结束等待`);
      assert.equal(result.error.code, "TIMEOUT");
      assert.equal(result.error.evidence.creationPending, true, `${kind} 必须保留 pending 证据`);
      assert.ok(
        result.error.evidence.pendingOperations.includes(kind),
        `${kind} 必须记录在 pendingOperations`,
      );
      error = result.error;
    } finally {
      gate.resolve();
      fs.mkdir = originalMkdir;
      fs.writeFile = originalWriteFile;
      fs.open = originalOpen;
    }
    await delay(30);
    // 共享副作用迟到完成也不改动已公布的失败证据，不自动清理/重建。
    assert.equal(error.code, "TIMEOUT");
    await fs.rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

test("snapshot output-write 迟到：不等待写 gate，保留现场且写 settle 后 close", async (t) => {
  const { base, rootPath, dataDir, sourcePath } = await snapshotFixture(t);
  const gate = deferred();
  const entered = deferred();
  const originalOpen = fs.open;
  let lateHandleClosed = false;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).includes("job-") && String(args[0]).endsWith("source.bin")) {
      const originalWrite = handle.write.bind(handle);
      const originalClose = handle.close.bind(handle);
      handle.write = async (...writeArgs) => {
        entered.resolve();
        await gate.promise;
        return originalWrite(...writeArgs);
      };
      handle.close = async (...closeArgs) => {
        lateHandleClosed = true;
        return originalClose(...closeArgs);
      };
    }
    return handle;
  };
  let error;
  try {
    const result = await Promise.race([
      createSnapshot({
        dataDir,
        rootPath,
        sourcePath,
        jobId: "synthetic",
        deadlineAtMs: performance.now() + 60,
      }).then(
        (value) => ({ value }),
        (caught) => ({ error: caught }),
      ),
      delay(500).then(() => ({ timeout: true })),
    ]);
    await entered.promise;
    await delay(150);
    assert.ok(result.error, "write deadline 内必须结束等待");
    assert.equal(result.error.evidence.creationPending, true);
    assert.ok(result.error.evidence.pendingOperations.includes("output-write"));
    error = result.error;
  } finally {
    gate.resolve();
    fs.open = originalOpen;
  }
  await delay(50);
  assert.equal(error.code, "TIMEOUT");
  assert.equal(lateHandleClosed, true, "write settle 后仍必须 close 本实例 fd");
  await fs.rm(base, { recursive: true, force: true }).catch(() => {});
});

test("snapshot 成功路径 close 失败：不返回快照，保留 closeFailed 独立证据", async (t) => {
  const { base, rootPath, dataDir, sourcePath } = await snapshotFixture(t);
  const originalOpen = fs.open;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).includes("job-") && String(args[0]).endsWith("source.bin")) {
      const originalClose = handle.close.bind(handle);
      handle.close = async () => {
        await originalClose();
        throw Object.assign(new Error("synthetic close failure"), { code: "EIO" });
      };
    }
    return handle;
  };
  try {
    await assert.rejects(
      createSnapshot({ dataDir, rootPath, sourcePath, jobId: "synthetic" }),
      (error) => {
        assert.equal(error.code, "SNAPSHOT_FAILED");
        assert.equal(error.evidence.closeFailed, true);
        assert.equal(error.evidence.resourceUnknown, true);
        return true;
      },
    );
  } finally {
    fs.open = originalOpen;
    await fs.rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

test("snapshot 创建失败带 pending：真实 queue 保留租约/现场，下一项拒绝", async (t) => {
  const gate = deferred();
  const entered = deferred();
  const originalMkdir = fs.mkdir;
  let dataDir;
  try {
    const setup = await queueFixture(
      t,
      {
        // 在 holder 之外无法拦截；直接在此测试里 patch fs.mkdir。
      },
      60,
    );
    dataDir = setup.dataDir;
    fs.mkdir = async (...args) => {
      if (String(args[0]).startsWith(path.join(dataDir, "audio-jobs", "job-"))) {
        entered.resolve();
        await gate.promise;
      }
      return originalMkdir(...args);
    };
    const submitted = await setup.queue.submit("asset-one");
    await entered.promise;
    await delay(180);
    const job = await setup.queue.get(submitted.id);
    assert.equal(job.state, "failed");
    assert.equal(setup.queue.busy, true, "创建 pending 必须故障 busy，不自动解锁");
    assert.ok(
      await fs.lstat(path.join(dataDir, "audio-jobs", ".queue-lease")).catch(() => null),
      "创建 unknown/pending 必须保留 queue 租约",
    );
    // 故障门不会自动解锁：新提交只能停在 queued，不能启动第二项。
    const next = await setup.queue.submit("asset-one");
    await delay(50);
    const nextJob = await setup.queue.get(next.id);
    assert.equal(nextJob.state, "queued", "故障租约下不得启动下一项");
    assert.equal(setup.queue.busy, true);
  } finally {
    gate.resolve();
    fs.mkdir = originalMkdir;
  }
  await delay(50);
});

test("hashPlainFile 迟到 read 的 close 失败：真实写入 closeFailed 证据而非空 catch", async (t) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "t13i-r3-exec-")));
  const file = path.join(dir, "synthetic-launcher");
  const bytes = Buffer.from("synthetic file; never executed");
  await fs.writeFile(file, bytes, { mode: 0o700 });
  const executor = new AudioExecutor({
    dataDir: dir,
    launcher: createAudioExecutorLauncherConfig({ path: file, sha256: sha256(bytes) }),
    limits: { wallMs: 60, termGraceMs: 1 },
  });
  t.after(async () => {
    await executor.dispose().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  const gate = deferred();
  const entered = deferred();
  const originalOpen = fs.open;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === file) {
      const originalRead = handle.read.bind(handle);
      const originalClose = handle.close.bind(handle);
      handle.read = async (...readArgs) => {
        entered.resolve();
        await gate.promise;
        return originalRead(...readArgs);
      };
      handle.close = async () => {
        await originalClose();
        throw Object.assign(new Error("synthetic late close failure"), { code: "EIO" });
      };
    }
    return handle;
  };
  let failure;
  let settled = false;
  const execution = executor.execute({}, {}).then(
    () => {
      settled = true;
    },
    (error) => {
      failure = error;
      settled = true;
    },
  );
  try {
    await Promise.race([entered.promise, delay(500).then(() => {
      throw Error("PREPARE read not entered");
    })]);
    await delay(150);
    assert.equal(settled, true, "入口 deadline 必须停止等待 PREPARE read");
    assert.equal(executor.busy, false);
  } finally {
    gate.resolve();
    await execution;
    fs.open = originalOpen;
  }
  await delay(50);
  assert.ok(failure);
  assert.equal(failure.evidence.closeFailed, true, "close 失败必须真实保存为独立证据");
  assert.ok(
    failure.evidence.lateCloseFailures.includes("PREPARE_HASH_READ_LATE_CLOSE"),
    "必须记录迟到 close 的标签",
  );
  await assert.rejects(executor.execute({}, {}), (error) => error.code === "EXECUTION_UNAVAILABLE");
});
