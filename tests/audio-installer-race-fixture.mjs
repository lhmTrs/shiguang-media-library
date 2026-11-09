/** Synthetic, loopback-only installer contention; no engine binary is executed. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fssync from "node:fs";
import https from "node:https";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { AudioEngine, AudioEngineError } from "../server/audio-engine.mjs";
import { makeRelease, makeTar, makeTlsFixture, tempDir, waitForJob } from "./audio-engine-fixtures.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded(promise, label, ms = 3000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: deadline`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function send(child, type) {
  return new Promise((resolve, reject) => {
    child.send({ type }, (error) => error ? reject(error) : resolve());
  });
}

function launch(env, t) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages = Object.fromEntries(["ready", "lock-ready", "result"].map((type) => [type, deferred()]));
  const record = { child, stdout: "", stderr: "", error: null, exit: null, close: null, cleanup: null };
  child.stdout.setEncoding("utf8").on("data", (chunk) => { record.stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { record.stderr += chunk; });
  child.on("message", (message) => {
    t.diagnostic(JSON.stringify({ pid: child.pid, ...message }));
    if (message.type === "cleanup") record.cleanup = message;
    messages[message.type]?.resolve(message);
  });
  child.on("error", (error) => { record.error = error.message; });
  child.once("exit", (code, signal) => { record.exit = { code, signal }; });
  record.closed = new Promise((resolve) => child.once("close", (code, signal) => {
    record.close = { code, signal };
    t.diagnostic(JSON.stringify({ pid: child.pid, exit: record.exit, close: record.close,
      error: record.error, stdout: record.stdout, stderr: record.stderr }));
    resolve(record.close);
  }));
  record.receive = (type) => bounded(Promise.race([
    messages[type].promise,
    record.closed.then(() => { throw new Error(`child ${child.pid} closed before ${type}: ${record.stderr}`); }),
  ]), `child ${child.pid} ${type}`);
  // Keep the result promise stable, including when a child closes before its peer.
  record.result = messages.result.promise;
  return record;
}

export async function runInstallerContention(t, mode) {
  const cleanup = [];
  const context = { after(fn) { cleanup.push(fn); } };
  const base = await tempDir(context, "shiguang-issue8-");
  const children = [];
  const gate = deferred();
  const requested = deferred();
  let server;
  let requests = 0;
  let responseClosed = 0;
  let failure;
  let resourcesClosed = false;
  try {
    const dataDir = path.join(base, "data");
    await fs.mkdir(dataDir);
    const tls = await makeTlsFixture(context);
    const archive = await makeTar([{ name: "audio-analyze", data: Buffer.from("#!/bin/sh\necho test-engine\n") }]);
    server = https.createServer({ key: tls.key, cert: tls.cert }, (_req, res) => {
      requests += 1;
      res.once("close", () => { responseClosed += 1; });
      res.writeHead(200, { "content-length": archive.length, connection: "close" });
      requested.resolve();
      gate.promise.then(() => { if (!res.destroyed) res.end(archive); });
    });
    server.listen(0, "127.0.0.1");
    await bounded(once(server, "listening"), "TLS listening");
    const env = {
      ...process.env,
      DATA_DIR: dataDir,
      RELEASE_JSON: JSON.stringify(makeRelease(archive, `https://127.0.0.1:${server.address().port}/engine.tar.gz`)),
      CA_FILE: path.join(tls.dir, "cert.pem"),
      AUDIO_INSTALLER_RACE_MODE: mode,
    };
    children.push(launch(env, t), launch(env, t));
    await Promise.all(children.map((child) => child.receive("ready")));
    if (mode === "queued") {
      // Both install() calls have passed the synchronous peek before either real
      // exclusive mkdir runs. Only the scheduling is gated; mkdir is not mocked.
      await Promise.all(children.map(({ child }) => send(child, "start")));
      await Promise.all(children.map((child) => child.receive("lock-ready")));
      assert.equal(fssync.existsSync(path.join(dataDir, "engines", ".audio-install.lock")), false);
      assert.equal(requests, 0);
      await Promise.all(children.map(({ child }) => send(child, "acquire")));
    } else {
      await send(children[0].child, "start");
    }
    // A request proves that the first process has acquired and written its lock.
    // Keep the response blocked until the other process reports an exact BUSY.
    await bounded(requested.promise, "lock holder download request");
    const lock = path.join(dataDir, "engines", ".audio-install.lock");
    const ownerBefore = await fs.readFile(path.join(lock, "owner.json"), "utf8");
    const owner = JSON.parse(ownerBefore);
    const before = await fs.stat(lock);
    assert.ok(children.some(({ child }) => child.pid === owner.pid));
    if (mode === "held") {
      assert.equal(owner.pid, children[0].child.pid);
      await send(children[1].child, "start");
    }
    const loser = await bounded(Promise.race(children.map((child) => child.receive("result"))), "contender BUSY");
    assert.equal(loser.code, "ENGINE_BUSY", JSON.stringify(loser));
    assert.equal(loser.kind, mode === "queued" ? "job" : "sync-busy");
    if (mode === "queued") assert.equal(loser.job.state, "error");
    assert.notEqual(loser.pid, owner.pid);
    assert.equal(await fs.readFile(path.join(lock, "owner.json"), "utf8"), ownerBefore, "loser must preserve lock owner");
    const after = await fs.stat(lock);
    assert.deepEqual([after.dev, after.ino], [before.dev, before.ino], "loser must preserve the actual lock");
    assert.equal(requests, 1, "only the lock holder may download");
    assert.equal(fssync.existsSync(path.join(dataDir, "engines/audio/current.json")), false);
    t.diagnostic(JSON.stringify({ mode, phase: "busy-before-release", ownerPid: owner.pid, loserPid: loser.pid, requests }));
    gate.resolve();
    const results = await bounded(Promise.all(children.map((child) => child.result)), "both terminal results");
    assert.equal(results.filter((result) => result.job?.state === "installed" && result.code === null).length, 1, JSON.stringify(results));
    assert.equal(results.filter((result) => result.code === "ENGINE_BUSY").length, 1, JSON.stringify(results));
    await bounded(Promise.all(children.map((child) => child.closed)), "both child close");
    for (const record of children) {
      assert.equal(record.error, null);
      assert.equal(record.cleanup?.settled, true);
      assert.deepEqual(record.exit, { code: 0, signal: null });
      assert.deepEqual(record.close, { code: 0, signal: null });
    }
    assert.equal(requests, 1);
    assert.equal(fssync.existsSync(lock), false, "installation lock must be released");
    assert.deepEqual(await fs.readdir(path.join(dataDir, "engines/.tmp")), []);
    assert.equal((await fs.readdir(path.join(dataDir, "engines/audio/versions"))).length, 1);
  } catch (error) {
    failure = error;
  } finally {
    // Release only this fixture's gate and request cooperative cancellation.
    // Never kill a process or delete directories while closure is unconfirmed.
    gate.resolve();
    const stopped = await Promise.allSettled(children.map(async (record) => {
      if (!record.close && record.child.connected) await bounded(send(record.child, "stop"), "send stop");
      await bounded(record.closed, "cooperative child close", 5000);
    }));
    const httpClosed = server ? await Promise.allSettled([bounded(new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }), "normal TLS close")]) : [];
    const errors = [...stopped, ...httpClosed].filter((result) => result.status === "rejected").map((result) => result.reason);
    if (children.some((record) => record.cleanup?.settled !== true)) {
      errors.push(new Error("child cleanup receipt missing; preserve fixture directories"));
    }
    try {
      const lock = path.join(base, "data/engines/.audio-install.lock");
      const tmp = path.join(base, "data/engines/.tmp");
      assert.equal(fssync.existsSync(lock), false, "residual lock must be preserved");
      if (fssync.existsSync(tmp)) assert.deepEqual(await fs.readdir(tmp), [], "residual install tasks must be preserved");
      assert.equal(responseClosed, requests, "HTTP responses must close before removing fixtures");
    } catch (error) {
      errors.push(error);
    }
    resourcesClosed = errors.length === 0;
    t.diagnostic(JSON.stringify({ mode, phase: "resources-closed", resourcesClosed, requests, responseClosed,
      listening: server?.listening ?? false, base }));
    if (resourcesClosed) {
      for (const fn of cleanup.reverse()) await fn();
    } else {
      t.diagnostic(`Preserved unconfirmed resources at ${base}`);
      failure = new AggregateError([...(failure ? [failure] : []), ...errors], "fixture cleanup incomplete");
    }
  }
  if (failure) throw failure;
  assert.equal(resourcesClosed, true);
  assert.equal(responseClosed, requests, "HTTP responses must close before cleanup completes");
}

async function runChild() {
  const start = deferred();
  const acquire = deferred();
  const mkdir = fs.mkdir;
  let stopping = false;
  let engine;
  const stop = () => {
    stopping = true;
    start.resolve();
    acquire.resolve();
    // Awaited again in finally before dispose/disconnect.
    engine?.cancel().catch((error) => { console.error(error); process.exitCode = 1; });
  };
  process.on("message", ({ type }) => {
    if (type === "start") start.resolve();
    if (type === "acquire") acquire.resolve();
    if (type === "stop") stop();
  });
  process.once("disconnect", stop);
  process.once("SIGTERM", stop);
  try {
    engine = new AudioEngine(process.env.DATA_DIR, {
      release: JSON.parse(process.env.RELEASE_JSON),
      ca: await fs.readFile(process.env.CA_FILE),
      platform: "darwin", arch: "arm64",
      idleTimeoutMs: 2000, totalTimeoutMs: 8000,
      diskFreeBytes: 1024 * 1024 * 1024,
    });
    if (process.env.AUDIO_INSTALLER_RACE_MODE === "queued") {
      const lock = path.join(process.env.DATA_DIR, "engines", ".audio-install.lock");
      fs.mkdir = async function (target, ...args) {
        if (target === lock) {
          await send(process, "lock-ready");
          await acquire.promise;
        }
        return mkdir.call(this, target, ...args);
      };
    }
    await send(process, "ready");
    await start.promise;
    if (stopping) return;
    let result;
    try {
      engine.install({ confirm: true });
    } catch (error) {
      if (!(error instanceof AudioEngineError) || error.code !== "ENGINE_BUSY") throw error;
      result = { kind: "sync-busy", code: error.code };
    }
    if (!result) {
      const status = await waitForJob(engine, { timeout: 7000 });
      result = { kind: "job", code: status.job.error?.code ?? null, job: status.job };
    }
    console.log(`RESULT ${JSON.stringify(result)}`);
    await new Promise((resolve, reject) => process.send({ type: "result", pid: process.pid, ...result },
      (error) => error ? reject(error) : resolve()));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    fs.mkdir = mkdir;
    if (engine) {
      await engine.cancel();
      engine.dispose();
    }
    if (process.connected) await new Promise((resolve, reject) => process.send({ type: "cleanup", settled: true },
      (error) => error ? reject(error) : resolve()));
    if (process.connected) process.disconnect();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await runChild();
