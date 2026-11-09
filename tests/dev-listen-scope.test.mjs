import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const project = path.resolve(import.meta.dirname, "..");
const execute = promisify(execFile);
const supported = ["darwin", "linux"].includes(process.platform)
  && spawnSync("lsof", ["-v"], { stdio: "ignore" }).status === 0;

async function processTree(pid) {
  // Only PID/PPID, never unrelated process arguments or environment variables.
  const { stdout } = await execute("ps", ["-axo", "pid=,ppid="], { timeout: 5000 });
  const rows = stdout.trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
  const owned = new Set([pid]);
  for (let size = 0; size !== owned.size;) {
    size = owned.size;
    for (const [child, parent] of rows) if (owned.has(parent)) owned.add(child);
  }
  return { pids: [...owned], rows: rows.filter(([child]) => owned.has(child)) };
}

async function listeners(pids) {
  const args = ["-nP", "-a", "-p", pids.join(","), "-iTCP", "-sTCP:LISTEN", "-Fpcn"];
  let raw;
  try {
    raw = (await execute("lsof", args, { timeout: 5000 })).stdout;
  } catch (error) {
    // lsof uses 1, with no output, for no matching descriptors.
    if (error.code !== 1 || error.stdout || error.stderr) throw error;
    raw = "";
  }
  let pid, command;
  const sockets = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    if (line.startsWith("c")) command = line.slice(1);
    if (line.startsWith("n")) sockets.push({ pid, command, address: line.slice(1) });
  }
  return { args, raw, sockets };
}

async function reservePort(port = 0) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
  });
  return { server, port: server.address().port };
}

const closeReservation = server => new Promise((resolve, reject) => {
  server.close(error => error ? reject(error) : resolve());
});

async function bounded(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

for (const scenario of [
  { name: "default-development", nodeEnv: undefined },
  { name: "development-port-fallback", nodeEnv: "development", collision: true },
  { name: "production", nodeEnv: "production" },
]) {
  test(`real ${scenario.name}: only the loopback App listener, then normal exit and port release`, {
    skip: supported ? false : "Requires macOS/Linux ps and lsof; listener scope is not verified here",
  }, async t => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "sg-listen-scope-"));
    const dataDir = path.join(temporary, "data");
    const evidence = { scenario, temporary, snapshots: [], requests: [], passed: false };
    let child, exited, log = "", blocker, passed = false;
    const ownedPids = new Set();
    async function snapshot(stage) {
      const tree = await processTree(child.pid);
      for (const pid of tree.pids) ownedPids.add(pid);
      const observed = { stage, ...tree, ...await listeners(tree.pids) };
      evidence.snapshots.push(observed);
      assert.deepEqual(observed.sockets.map(({ pid, address }) => ({ pid, address })), [
        { pid: child.pid, address: `127.0.0.1:${evidence.instance.port}` },
      ], "No wildcard, LAN, HMR (including 24678), or extra descendant TCP listener");
    }
    try {
      await fs.mkdir(dataDir);
      await fs.mkdir(path.join(temporary, "no-tools"));
      await fs.mkdir(path.join(temporary, "codex-home"));
      const releaseConfig = path.join(temporary, "cloud-disabled.json");
      await fs.writeFile(releaseConfig, JSON.stringify({ schemaVersion: 1, enabled: false }));
      // A minimal environment prevents inherited container/AI/MySQL settings.
      const env = {
        PATH: path.join(temporary, "no-tools"),
        CODEX_HOME: path.join(temporary, "codex-home"),
        MEDIA_CODEX_BIN: path.join(temporary, "no-tools", "disabled-codex"),
        MEDIA_CODEX_AUTOCONNECT: "0",
        MEDIA_CONTAINER: "0",
        MEDIA_DATA_DIR: dataDir,
        MEDIA_PERSONAL_ITEM_DIR: path.join(temporary, "personal-item"),
        MEDIA_SKIP_IMPORT: "1", MEDIA_SKIP_RECONCILE: "1", MEDIA_NO_WATCH: "1",
        MEDIA_READONLY_FILES: "1", SHIGUANG_AUDIO_ANALYSIS: "0",
        SHIGUANG_CLOUD_RELEASE_CONFIG: releaseConfig,
      };
      const reservation = await reservePort();
      blocker = reservation.server;
      assert.notEqual(reservation.port, 4317);
      assert.ok(reservation.port > 4317 && reservation.port <= 65506, "Free high port with fallback headroom");
      evidence.requestedPort = reservation.port;
      env.PORT = String(reservation.port);
      if (!scenario.collision) { await closeReservation(blocker); blocker = null; }
      if (scenario.nodeEnv) env.NODE_ENV = scenario.nodeEnv;
      evidence.environment = env;
      child = spawn(process.execPath, ["server/index.mjs"], {
        cwd: project, env, stdio: ["ignore", "pipe", "pipe"],
      });
      evidence.pid = child.pid;
      ownedPids.add(child.pid);
      child.stdout.on("data", chunk => { log += chunk; });
      child.stderr.on("data", chunk => { log += chunk; });
      exited = new Promise((resolve, reject) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
        child.once("error", reject);
      });
      const startupDeadline = Date.now() + 20000;
      await (async () => {
        while (true) {
          assert.equal(child.exitCode, null, log);
          assert.equal(child.signalCode, null, log);
          assert.ok(Date.now() < startupDeadline, "Owned App startup timed out");
          try {
            evidence.instance = JSON.parse(await fs.readFile(path.join(dataDir, "server.json"), "utf8"));
            break;
          } catch (error) {
            if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
          }
          await delay(30);
        }
      })();
      const instance = evidence.instance;
      assert.equal(instance.pid, child.pid);
      assert.ok(instance.port >= reservation.port && instance.port < reservation.port + 30);
      assert.equal(instance.url, `http://127.0.0.1:${instance.port}`);
      assert.equal(scenario.collision ? instance.port > reservation.port : instance.port === reservation.port, true);
      await snapshot("ready");
      const request = async (route, headers = {}) => {
        const response = await fetch(instance.url + route, {
          headers: { connection: "close", ...headers }, signal: AbortSignal.timeout(10000),
        });
        evidence.requests.push({ route, status: response.status });
        assert.equal(response.status, 200, route);
        return response;
      };
      const session = await request("/api/session");
      const identity = await session.json();
      assert.equal(identity.app, "shiguang-local-media");
      assert.equal(identity.instanceId, instance.instanceId);
      const cookie = session.headers.get("set-cookie").split(";")[0];
      for (const route of ["/api/prompt-codex/status", "/api/concierge/status"]) {
        const status = await (await request(route, { cookie })).json();
        assert.equal(status.connectionAttempted, false);
        assert.equal(status.connected, false);
      }
      assert.deepEqual(await (await request("/api/roots", { cookie })).json(), []);
      assert.deepEqual(await (await request("/api/reconcile", { cookie })).json(), { roots: [], watching: 0 });
      if (scenario.nodeEnv !== "production") {
        assert.match(await (await request("/")).text(), /\/@vite\/client/);
        assert.match(await (await request("/@vite/client")).text(), /WebSocket/);
        assert.match(await (await request("/src/main.tsx")).text(), /createRoot/);
      } else {
        // Listener coverage needs no build. If dist exists, verify static serving
        // against those bytes, without claiming a current-source UI build.
        const html = await fs.readFile(path.join(project, "dist/index.html"), "utf8").catch(error => {
          if (error.code !== "ENOENT") throw error;
          return null;
        });
        evidence.staticHtmlCompared = html !== null;
        if (html !== null) assert.equal(await (await request("/")).text(), html);
      }
      await snapshot("after-http-and-vite-transforms");
      await delay(250);
      await snapshot("settled");
      // An occupied 24678 must not hide a regression behind a bind failure.
      assert.doesNotMatch(log, /WebSocket server error:/);
      passed = true;
    } finally {
      try {
        if (child) {
          evidence.stopSignal = scenario.nodeEnv === "production" ? "SIGINT" : "SIGTERM";
          if (child.exitCode === null && child.signalCode === null) child.kill(evidence.stopSignal);
          evidence.actualExit = await bounded(exited, 15000, "Owned App close UNKNOWN; no forced kill");
          evidence.applicationClosedKnown = log.includes("APPLICATION_CLOSED_KNOWN");
          assert.equal(evidence.applicationClosedKnown, true, log);
          assert.deepEqual(evidence.actualExit, { code: 0, signal: null });
          // Also check children observed before shutdown if they were reparented.
          const { stdout } = await execute("ps", ["-axo", "pid="], { timeout: 5000 });
          evidence.remainingOwnedPids = stdout.trim().split(/\s+/).map(Number).filter(pid => ownedPids.has(pid));
          evidence.listenersAfterExit = await listeners([...ownedPids]);
          assert.deepEqual(evidence.remainingOwnedPids, []);
          assert.deepEqual(evidence.listenersAfterExit.sockets, []);
          if (evidence.instance) {
            const rebound = await reservePort(evidence.instance.port);
            await closeReservation(rebound.server);
            evidence.portReleased = true;
          }
        }
        evidence.passed = passed;
      } finally {
        if (blocker) await closeReservation(blocker);
        // Retain failed scenes. Never force-kill or remove an unsettled scene.
        if (passed && evidence.applicationClosedKnown && evidence.portReleased) {
          await fs.rm(temporary, { recursive: true, force: true });
          evidence.temporaryRemoved = true;
        }
        if (process.env.DEV_LISTEN_EVIDENCE) {
          const directory = path.resolve(process.env.DEV_LISTEN_EVIDENCE);
          await fs.mkdir(directory, { recursive: true });
          await fs.writeFile(path.join(directory, scenario.name + ".json"), JSON.stringify(evidence, null, 2) + "\n");
          await fs.writeFile(path.join(directory, scenario.name + ".log"), log);
        }
        t.diagnostic(JSON.stringify({ scenario: scenario.name, pid: child?.pid, port: evidence.instance?.port,
          actualExit: evidence.actualExit, closedKnown: evidence.applicationClosedKnown,
          portReleased: evidence.portReleased, retained: evidence.temporaryRemoved ? undefined : temporary }));
        if (child && child.exitCode === null && child.signalCode === null) {
          child.unref(); child.stdout.destroy(); child.stderr.destroy();
        }
      }
    }
  });
}
