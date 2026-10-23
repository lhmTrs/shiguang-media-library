#!/usr/bin/env node
/**
 * T-LOCAL-013A 一键复跑：先尝试编译实验 launcher（仅现有 CLT，不装依赖），再跑三组测试。
 * 用法：node collab/results/T-LOCAL-013A/run-tests.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build");
const FIXTURES = path.join(HERE, "fixtures");
const TESTS = path.join(HERE, "tests");
fs.mkdirSync(BUILD, { recursive: true });

function hasCompiler() {
  try {
    const out = execFileSync("/usr/bin/xcode-select", ["-p"], { encoding: "utf8", timeout: 2000 }).trim();
    return Boolean(out);
  } catch {
    return false;
  }
}

function build(name) {
  const source = path.join(FIXTURES, `${name}.c`);
  const target = path.join(BUILD, name);
  if (!fs.existsSync(source)) return false;
  if (fs.existsSync(target)) return true;
  try {
    execFileSync("/usr/bin/cc", ["-O2", "-Wall", "-Wextra", "-o", target, source], { stdio: "inherit", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

if (hasCompiler()) {
  build("rlimit-launcher");
  build("rss-of");
} else {
  console.log("# no Command Line Tools; launcher tests will be skipped");
}

const files = [
  path.join(TESTS, "executor.test.mjs"),
  path.join(TESTS, "launcher.test.mjs"),
  path.join(TESTS, "brief.test.mjs"),
];
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files], {
  stdio: "inherit",
  timeout: 120_000,
});
process.exit(result.status ?? 1);
