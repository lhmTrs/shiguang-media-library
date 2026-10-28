/**
 * T13I 证据矩阵合成引擎夹具。
 * 只做进程/IO/退出行为，不读真实素材、不运行发行引擎、不联网。
 */
import fs from "node:fs";
import path from "node:path";

function success() {
  process.stdout.write(
    JSON.stringify({ bpm: 120, key: "C", evidenceFixture: true }) + "\n",
  );
}

function sleepForever() {
  return new Promise(() => {
    setInterval(() => {}, 60_000);
  });
}

export async function run(mode, options = {}) {
  switch (mode) {
    case "success":
      success();
      break;

    case "nonzero":
      process.stderr.write("synthetic-stderr-secret\n");
      process.exitCode = 7;
      break;

    case "sigterm":
      process.kill(process.pid, "SIGTERM");
      await sleepForever();
      break;

    case "sigxcpu":
      process.kill(process.pid, "SIGXCPU");
      await sleepForever();
      break;

    case "sleep":
      await sleepForever();
      break;

    case "sleep-pid":
      fs.writeFileSync(options.pidFile, String(process.pid));
      await sleepForever();
      break;

    case "stdout-flood": {
      const chunk = Buffer.alloc(4096, "x");
      const timer = setInterval(() => {
        for (let index = 0; index < 8; index += 1) process.stdout.write(chunk);
      }, 5);
      timer.unref?.();
      await sleepForever();
      break;
    }

    case "stderr-flood": {
      const chunk = Buffer.alloc(4096, "e");
      const timer = setInterval(() => {
        for (let index = 0; index < 8; index += 1) process.stderr.write(chunk);
      }, 5);
      timer.unref?.();
      await sleepForever();
      break;
    }

    case "corrupt-owner": {
      fs.writeFileSync(path.join(process.cwd(), "..", ".owner.json"), '{"token":"wrong"}\n');
      success();
      break;
    }

    default:
      process.stderr.write("unknown synthetic mode\n");
      process.exitCode = 64;
  }
}
