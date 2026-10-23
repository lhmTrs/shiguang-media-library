/**
 * T-LOCAL-013A 合成子进程。只做进程/IO/env 行为，不读取真实素材、不联网公网。
 * 用法：node child.mjs <mode> [args...]
 */
import net from "node:net";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const [, , mode, ...args] = process.argv;

switch (mode) {
  case "success":
    process.stdout.write(JSON.stringify({
      bpm: 128.4,
      key: { best: "A", r: 0.87 },
      loud: { peak: -0.8, rms: -14.2 },
      energy: { min: -40, max: -2, std: 6.1 },
      fit: { beat: 0.91, tonal: 0.82, chord: 0.74 },
      seg: [1.2, 3.4],
    }) + "\n");
    break;

  case "zero-values":
    process.stdout.write(JSON.stringify({
      bpm: null,
      key: { best: "unknown" },
      loud: { peak: 0, rms: -0 },
      energy: { min: 0, max: 0, std: 0 },
      unknown_future_field: "ignored",
    }) + "\n");
    break;

  case "nonzero":
    process.stderr.write("synthetic failure: mode=nonzero\n");
    process.exitCode = 7;
    break;

  case "timeout":
    // 保持存活但不烧 CPU；wall deadline 由 executor 负责。
    setInterval(() => {}, 60_000);
    break;

  case "cancel":
    setInterval(() => {}, 60_000);
    break;

  case "stdout-limit": {
    const chunk = Buffer.alloc(8192, "x");
    const timer = setInterval(() => {
      for (let i = 0; i < 20; i += 1) process.stdout.write(chunk);
    }, 10);
    timer.unref?.();
    setInterval(() => {}, 60_000);
    break;
  }

  case "stderr-limit": {
    const chunk = Buffer.alloc(8192, "e");
    const timer = setInterval(() => {
      for (let i = 0; i < 20; i += 1) process.stderr.write(chunk);
    }, 10);
    timer.unref?.();
    setInterval(() => {}, 60_000);
    break;
  }

  case "grandchild": {
    const pidFile = args[0];
    const { spawn } = await import("node:child_process");
    const grandchild = spawn(process.execPath, [fileURLToPath(import.meta.url), "sleep"], {
      stdio: "ignore",
    });
    fs.writeFileSync(pidFile, String(grandchild.pid));
    setInterval(() => {}, 60_000);
    break;
  }

  case "sleep":
    setInterval(() => {}, 60_000);
    break;

  case "env": {
    const allowed = ["PATH", "HOME", "TMPDIR", "LANG", "BLAS_NUM_THREADS", "OMP_NUM_THREADS"];
    const sentinels = [
      "API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY",
      "PYTHONPATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "JWT_SECRET", "AWS_SECRET_ACCESS_KEY",
    ];
    const report = { allowed: {}, sentinels: {} };
    for (const key of allowed) report.allowed[key] = process.env[key] ?? null;
    for (const key of sentinels) report.sentinels[key] = Object.prototype.hasOwnProperty.call(process.env, key);
    process.stdout.write(JSON.stringify(report) + "\n");
    break;
  }

  case "connect": {
    const [host, portText] = args;
    const port = Number(portText);
    const socket = net.connect({ host, port });
    socket.setTimeout(1500);
    socket.once("connect", () => {
      process.stdout.write(JSON.stringify({ connected: true }) + "\n");
      socket.destroy();
    });
    socket.once("timeout", () => {
      process.stdout.write(JSON.stringify({ connected: false, code: "TIMEOUT" }) + "\n");
      socket.destroy();
    });
    socket.once("error", (error) => {
      process.stdout.write(JSON.stringify({ connected: false, code: error.code || "ERROR" }) + "\n");
    });
    break;
  }

  case "nofile": {
    // 先把结果文件 fd 留好，再耗尽 fd；避免 Node 懒初始化 stdout 时先 EMFILE 导致无结果。
    const outFile = args[0];
    const outFd = fs.openSync(outFile, "w");
    const handles = [];
    let errorCode = null;
    for (let i = 0; i < 5000; i += 1) {
      try {
        handles.push(fs.openSync("/dev/null", "r"));
      } catch (error) {
        errorCode = error.code || "ERROR";
        break;
      }
    }
    fs.writeSync(outFd, JSON.stringify({ opened: handles.length, errorCode }) + "\n");
    fs.closeSync(outFd);
    for (const fd of handles) {
      try { fs.closeSync(fd); } catch {}
    }
    break;
  }

  case "fsize": {
    const target = args[0];
    const chunk = Buffer.alloc(8192, "f");
    try {
      const fd = fs.openSync(target, "w");
      for (let i = 0; i < 512; i += 1) fs.writeSync(fd, chunk);
      fs.closeSync(fd);
    } catch (error) {
      process.stderr.write(String(error.code || "ERROR") + "\n");
    }
    break;
  }

  case "cpu": {
    const end = Date.now() + 5000;
    let n = 0;
    while (Date.now() < end) n += 1;
    process.stdout.write(JSON.stringify({ iterations: n }) + "\n");
    break;
  }

  default:
    process.stderr.write(`unknown mode: ${mode}\n`);
    process.exitCode = 64;
}
