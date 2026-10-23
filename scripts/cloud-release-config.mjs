#!/usr/bin/env node
/**
 * T-LOCAL-007：生成/校验「发行版云端连接」配置。
 *
 * 只接受操作者显式给出的两个 HTTPS origin 和两个公开 CA 文件；不会扫描
 * .runtime、home 目录或任何真实运行库去猜证书。输出文件只含公共信息。
 *
 * 用法：
 *   node scripts/cloud-release-config.mjs \
 *     --api-origin https://cloud.example.com:8443 \
 *     --enrollment-origin https://cloud.example.com:8444 \
 *     --server-ca /path/to/server-ca.pem \
 *     --device-ca /path/to/device-ca.pem
 *   node scripts/cloud-release-config.mjs --check
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_RELEASE_CONFIG,
  MAX_RELEASE_CONFIG_BYTES,
  loadReleaseConfig,
  parseOrigin,
  parsePublicCertificates,
  validateReleaseConfig,
} from "../server/cloud-release-config.mjs";

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const defaultOut = path.join(project, "config/cloud-release.json");

function usage(message) {
  if (message) console.error(message);
  console.error(
    [
      "用法: node scripts/cloud-release-config.mjs --api-origin <https://host[:port]> --enrollment-origin <https://host[:port]> --server-ca <pem> --device-ca <pem> [--out <file>] [--force]",
      "      node scripts/cloud-release-config.mjs --check [file]",
    ].join("\n"),
  );
  process.exit(2);
}

function parseArgs(argv) {
  const args = { out: defaultOut, force: false, check: false, checkFile: null, enable: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) usage(`${arg} 缺少参数`);
      return value;
    };
    if (arg === "--api-origin") args.apiOrigin = next();
    else if (arg === "--enrollment-origin") args.enrollmentOrigin = next();
    else if (arg === "--server-ca") args.serverCa = next();
    else if (arg === "--device-ca") args.deviceCa = next();
    else if (arg === "--out") args.out = path.resolve(next());
    else if (arg === "--force") args.force = true;
    else if (arg === "--disable") args.enable = false;
    else if (arg === "--check") {
      args.check = true;
      if (argv[i + 1] && !argv[i + 1].startsWith("--")) args.checkFile = path.resolve(argv[++i]);
    } else if (arg === "--help" || arg === "-h") usage();
    else usage(`未知参数：${arg}`);
  }
  return args;
}

async function readPublicCa(file, label) {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    throw new Error(`${label} 文件不存在或不可读`);
  }
  if (!stat.isFile()) throw new Error(`${label} 不是普通文件`);
  if (stat.size > MAX_RELEASE_CONFIG_BYTES) throw new Error(`${label} 过大`);
  const pem = await fs.readFile(file, "utf8");
  const parsed = parsePublicCertificates(pem, label);
  if (!parsed.certificates.some((cert) => cert.ca === true)) throw new Error(`${label} 必须包含 CA 证书`);
  return parsed.pem;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.check) {
    const file = args.checkFile || defaultOut;
    const result = await loadReleaseConfig(file);
    const summary = {
      file,
      schemaVersion: result.schemaVersion,
      enabled: result.enabled,
      usable: result.usable,
      apiOrigin: result.apiOrigin || null,
      enrollmentOrigin: result.enrollmentOrigin || null,
      errors: result.errors,
      warnings: result.warnings,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (result.errors.length) process.exit(1);
    return;
  }

  if (!args.apiOrigin || !args.enrollmentOrigin || !args.serverCa || !args.deviceCa)
    usage("生成配置必须同时提供 --api-origin、--enrollment-origin、--server-ca、--device-ca");

  const apiOrigin = parseOrigin(args.apiOrigin, "apiOrigin");
  const enrollmentOrigin = parseOrigin(args.enrollmentOrigin, "enrollmentOrigin");
  if (apiOrigin === enrollmentOrigin) throw new Error("apiOrigin 与 enrollmentOrigin 必须是不同端口/入口");
  const serverCaPem = await readPublicCa(args.serverCa, "serverCaPem");
  const deviceCaPem = await readPublicCa(args.deviceCa, "deviceCaPem");

  const config = {
    ...DEFAULT_RELEASE_CONFIG,
    enabled: args.enable === true,
    apiOrigin,
    enrollmentOrigin,
    serverCaPem,
    deviceCaPem,
  };
  const checked = validateReleaseConfig(config);
  if (checked.errors.length) throw new Error(checked.errors.join("；"));

  let outExists = true;
  try {
    await fs.access(args.out);
  } catch {
    outExists = false;
  }
  if (outExists && !args.force)
    throw new Error(`输出文件已存在，若要覆盖请显式加 --force：${args.out}`);
  await fs.mkdir(path.dirname(args.out), { recursive: true, mode: 0o755 });
  const text = JSON.stringify(checked.config, null, 2) + "\n";
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text))
    throw new Error("生成的配置包含私钥，已拒绝写入");
  const tmp = `${args.out}.tmp-${process.pid}`;
  await fs.writeFile(tmp, text, { mode: 0o644 });
  await fs.rename(tmp, args.out);
  await fs.chmod(args.out, 0o644);
  console.log(
    JSON.stringify(
      {
        out: args.out,
        enabled: checked.config.enabled,
        apiOrigin: checked.config.apiOrigin,
        enrollmentOrigin: checked.config.enrollmentOrigin,
        bytes: Buffer.byteLength(text),
        containsPrivateKey: false,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(`生成/校验失败：${e.message}`);
  process.exit(1);
});
