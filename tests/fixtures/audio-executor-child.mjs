/**
 * T-LOCAL-013H 合成引擎夹具。只做进程/IO/env/rlimit 可观察行为，不读真实素材、
 * 不联网、不分析音频。由 tests/audio-executor.test.mjs 临时复制为“发行二进制”。
 *
 * 用法：audio-executor-child.mjs <mode> [args...]
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const [, , mode, ...args] = process.argv;
const self = fileURLToPath(import.meta.url);

function success() {
  process.stdout.write(
    JSON.stringify({
      bpm: 128.4,
      key: { best: "A", r: 0.87 },
      loud: { peak: -0.8, rms: -14.2 },
      energy: { min: -40, max: -2, std: 6.1 },
      fit: { beat: 0.91, tonal: 0.82, chord: 0.74 },
      seg: [1.2, 3.4],
    }) + "\n",
  );
}

switch (mode) {
  case "success":
    success();
    break;

  case "argv":
    process.stdout.write(JSON.stringify({ args }) + "\n");
    break;

  case "startup":
    if (args[0]) fs.writeFileSync(args[0], String(Date.now()));
    success();
    break;

  case "nonzero":
    process.stderr.write("synthetic failure: nonzero\n");
    process.exitCode = 7;
    break;

  case "sleep":
    setInterval(() => {}, 60_000);
    break;

  case "stdout-flood": {
    const chunk = Buffer.alloc(4096, "x");
    const timer = setInterval(() => {
      for (let i = 0; i < 8; i += 1) process.stdout.write(chunk);
    }, 5);
    timer.unref?.();
    setInterval(() => {}, 60_000);
    break;
  }

  case "stderr-flood": {
    const chunk = Buffer.alloc(4096, "e");
    const timer = setInterval(() => {
      for (let i = 0; i < 8; i += 1) process.stderr.write(chunk);
    }, 5);
    timer.unref?.();
    setInterval(() => {}, 60_000);
    break;
  }

  case "multibyte":
    process.stdout.write("音".repeat(7));
    break;

  case "env": {
    const sentinels = [
      "API_KEY",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "ALL_PROXY",
      "PYTHONPATH",
      "DYLD_INSERT_LIBRARIES",
      "DYLD_LIBRARY_PATH",
      "NODE_OPTIONS",
      "JWT_SECRET",
      "AWS_SECRET_ACCESS_KEY",
    ];
    const report = { allowed: {}, sentinels: {} };
    for (const key of [
      "PATH",
      "HOME",
      "TMPDIR",
      "TMP",
      "TEMP",
      "LANG",
      "LC_ALL",
      "BLAS_NUM_THREADS",
      "OMP_NUM_THREADS",
      "MKL_NUM_THREADS",
      "OPENBLAS_NUM_THREADS",
      "VECLIB_MAXIMUM_THREADS",
    ]) {
      report.allowed[key] = process.env[key] ?? null;
    }
    for (const key of sentinels) {
      report.sentinels[key] = Object.prototype.hasOwnProperty.call(process.env, key);
    }
    process.stdout.write(JSON.stringify(report) + "\n");
    break;
  }

  case "grandchild-inherit":
  case "grandchild-closed": {
    const pidFile = args[0];
    const stdio = mode === "grandchild-inherit" ? ["ignore", "inherit", "inherit"] : "ignore";
    const grandchild = spawn(process.execPath, [self, "sleep"], { stdio });
    fs.writeFileSync(pidFile, String(grandchild.pid));
    setTimeout(() => process.exit(0), 50);
    break;
  }

  case "nofile": {
    // 先把 stdout 流初始化好，否则 fd 耗尽后惰性打开 stdout 会先失败而测不到 EMFILE。
    void process.stdout;
    const handles = [];
    let errorCode = null;
    for (let i = 0; i < 500; i += 1) {
      try {
        handles.push(fs.openSync("/dev/null", "r"));
      } catch (error) {
        errorCode = error?.code || "ERROR";
        break;
      }
    }
    process.stdout.write(JSON.stringify({ opened: handles.length, errorCode }) + "\n");
    for (const fd of handles) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    break;
  }

  case "fsize": {
    const target = args[0];
    const chunk = Buffer.alloc(8192, "f");
    let written = 0;
    try {
      const fd = fs.openSync(target, "w");
      for (let i = 0; i < 64; i += 1) {
        fs.writeSync(fd, chunk);
        written += chunk.length;
      }
      fs.closeSync(fd);
    } catch (error) {
      process.stdout.write(JSON.stringify({ written, errorCode: error?.code || "SIGNAL" }) + "\n");
    }
    break;
  }

  case "cpu": {
    const end = Date.now() + 10_000;
    let iterations = 0;
    while (Date.now() < end) iterations += 1;
    process.stdout.write(JSON.stringify({ iterations }) + "\n");
    break;
  }

  default:
    process.stderr.write("unknown synthetic mode\n");
    process.exitCode = 64;
}
