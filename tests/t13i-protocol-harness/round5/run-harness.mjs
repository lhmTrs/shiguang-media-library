#!/usr/bin/env node
/**
 * T13I-PROTOCOL-HARNESS-20261024：canonical 合成场景 CLI。
 *
 *   node tests/t13i-protocol-harness/round5/run-harness.mjs [--out <json>] [--case <name>]
 *
 * 默认只跑注入 fake；没有 --real 开关，也不读取 SHIGUANG_T13I_REAL_ENGINE 等
 * 环境变量。任何真实执行/安装请求由 harness gate 在副作用前拒绝。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { runProtocolHarness } from "./harness.mjs";
import { CASE_NAMES, createCase, createCanonicalCases } from "./scenarios.mjs";

function readArgs(argv) {
  const out = { outFile: null, onlyCase: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") {
      out.outFile = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--case") {
      out.onlyCase = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (args.help) {
    console.log("usage: node tests/t13i-protocol-harness/round5/run-harness.mjs [--out <json>] [--case <name>]");
    console.log(`cases: ${CASE_NAMES.join(", ")}`);
    return;
  }
  if (args.onlyCase !== null && !CASE_NAMES.includes(args.onlyCase)) {
    throw new Error(`unknown case: ${args.onlyCase}`);
  }

  const entries = args.onlyCase === null ? createCanonicalCases() : [createCase(args.onlyCase)];
  const results = [];
  let passed = 0;
  let failed = 0;
  for (const entry of entries) {
    const result = await runProtocolHarness(entry.scenario, entry.adapters);
    const pass =
      result.code === entry.expectedCode &&
      (entry.expectedDetail === undefined ||
        entry.expectedDetail === null ||
        result.detail === entry.expectedDetail);
    if (pass) passed += 1;
    else failed += 1;
    const summary = {
      name: entry.name,
      expectedCode: entry.expectedCode,
      actualCode: result.code,
      detail: result.detail,
      pass,
      timingMs: result.timing?.totalMs ?? null,
      cleanup: result.cleanup
        ? { ok: result.cleanup.ok, tempDirRemoved: result.cleanup.tempDirRemoved }
        : null,
    };
    results.push({ ...summary, result });
    console.log(JSON.stringify(summary));
  }

  const payload = {
    harness: "T13I-PROTOCOL-HARNESS-20261024",
    mode: "injected-fakes-only",
    generatedAt: new Date().toISOString(),
    cases: entries.length,
    passed,
    failed,
    results,
  };
  if (args.outFile !== null) {
    const target = path.resolve(args.outFile);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ wrote: target, cases: payload.cases, passed, failed }));
  }
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  // 不打印 error.message（可能是真实 adapter 抛出的内部文案）；只给固定类型。
  console.error(JSON.stringify({ harnessError: error?.code ?? "HARNESS_CLI_FAILED" }));
  process.exitCode = 1;
});
