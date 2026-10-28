/**
 * MUSIC-ENGINE-PREFLIGHT-IMPL-20261027 合成测试。
 *
 * 全部输入在 RETAIN_ALL 临时根内生成；不读真实插件/模型/素材，不联网、不构建、
 * 不 import Python、不执行引擎。测试可 spawn 入口进程，但入口源码零 child_process。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  runPreflight,
  computeFinalExit,
  createLedger,
  closeOwned,
  REQUIRED_MATERIAL_IDS,
  LIMITS,
} from "../scripts/music-engine-preflight.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "music-engine-preflight");
const SCRIPT = path.join(HERE, "..", "scripts", "music-engine-preflight.mjs");
const sha = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const TICKET = "MUSIC-ENGINE-PREFLIGHT-TEST-01";
const LAYOUT = "legacy-onefile";
const CHILD_TIMEOUT_MS = 20_000;
const CHILD_MAX_BUFFER = 256 * 1024;

function realTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return fs.realpathSync(dir);
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function defaultPins(env) {
  const specs = [
    { id: "plugin.analyze", role: "source", name: "analyze.py" },
    { id: "model.yamnet", role: "model", name: "yamnet.onnx" },
    { id: "toolchain.pyvenv", role: "toolchain", name: "pyvenv.cfg" },
  ];
  return specs.map((spec) => {
    const file = path.join(env.src, spec.name);
    return {
      id: spec.id,
      role: spec.role,
      path: file,
      bytes: fs.statSync(file).size,
      sha256: sha(fs.readFileSync(file)),
      required: true,
    };
  });
}

function makeEnv(options = {}) {
  const root = realTmp("mep-test-");
  const collab = path.join(root, "collab");
  const results = path.join(collab, "results");
  const evidenceDir = path.join(collab, "evidence");
  const src = path.join(root, "src");
  fs.mkdirSync(results, { recursive: true });
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.mkdirSync(src, { recursive: true });

  fs.writeFileSync(path.join(src, "analyze.py"), "print('fixture')\n");
  fs.writeFileSync(path.join(src, "yamnet.onnx"), Buffer.from("synthetic-model-bytes"));
  fs.writeFileSync(path.join(src, "pyvenv.cfg"), "version = 3.12.5\n");

  const env = { root, collab, results, evidenceDir, src, ticket: options.ticket ?? TICKET };
  const license = path.join(evidenceDir, "license.txt");
  fs.copyFileSync(path.join(FIXTURES, "evidence-license.txt"), license);

  const pins = { schema: "shiguang-music-engine-build-pins/v1", entries: defaultPins(env) };
  if (options.mutatePins) options.mutatePins(pins, env);
  const pinsPath = path.join(root, "pins.json");
  writeJson(pinsPath, pins);
  const pinsSha = sha(fs.readFileSync(pinsPath));

  const toolchainPins = pins.entries.filter((entry) => entry.role === "toolchain");
  const manifest = {
    schema: "shiguang-music-engine-toolchain-manifest/v1",
    entries: toolchainPins.map((entry) => ({ id: entry.id, sha256: entry.sha256 })),
  };
  const manifestPath = path.join(evidenceDir, "toolchain-manifest.json");
  writeJson(manifestPath, manifest);

  const approval = {
    schema: "shiguang-music-engine-preflight-approval/v1",
    approvalId: `APPROVAL-${env.ticket}`,
    ticket: env.ticket,
    scope: "preflight",
    buildAuthorized: false,
    requiredMaterialIds: [...REQUIRED_MATERIAL_IDS],
    allowedEvidence: [
      {
        id: "evidence.license",
        path: license,
        sha256: sha(fs.readFileSync(license)),
        locator: "fixture:evidence-license",
      },
      {
        id: "evidence.toolchain-manifest",
        path: manifestPath,
        sha256: sha(fs.readFileSync(manifestPath)),
        locator: "fixture:toolchain-manifest",
      },
    ],
  };
  if (options.mutateApproval) options.mutateApproval(approval, env);

  const membersFixture = options.membersFixture === "v1" ? "members-v1.json" : "members-v0.json";
  let membersRaw = fs.readFileSync(path.join(FIXTURES, membersFixture), "utf8");
  if (options.membersRaw) membersRaw = options.membersRaw;
  if (options.padMembers) membersRaw = `${membersRaw}${" ".repeat(options.padMembers)}`;
  const membersPath = path.join(root, "members.json");
  fs.writeFileSync(membersPath, membersRaw);
  const members = JSON.parse(fs.readFileSync(path.join(FIXTURES, membersFixture), "utf8"));

  const layout = options.layout ?? LAYOUT;
  const expectation = {
    schema: "shiguang-music-engine-preflight-expectation/v1",
    ticket: env.ticket,
    layout,
    external: { archiveSha256: members.archive.sha256 },
    projection: {
      entries: members.members.length,
      bytes: members.totalMemberBytes,
      symlinks: 0,
      maxFileBytes: Math.max(...members.members.map((member) => member.bytes)),
      archiveBytes: members.archive.bytes,
      provenance: "synthetic-fixture/NOT-A-BUILD-ARTIFACT",
    },
    toolchainCoverage: {
      declaredComplete: true,
      categories: { interpreter: true, hooksCode: true, dependencyClosure: true },
      manifestRef: "evidence.toolchain-manifest",
    },
  };
  if (options.mutateExpectation) options.mutateExpectation(expectation, env);
  const expectationPath = path.join(root, "expectation.json");
  writeJson(expectationPath, expectation);

  const approvalPath = path.join(root, "approval.json");
  writeJson(approvalPath, approval);
  const approvalSha = sha(fs.readFileSync(approvalPath));

  const materials = {
    schema: "shiguang-music-engine-license-materials/v1",
    ticket: env.ticket,
    items: REQUIRED_MATERIAL_IDS.map((id) => ({
      id,
      status: "MATCH",
      evidenceRef: "evidence.license",
      locator: "fixture:evidence-license",
    })),
  };
  if (options.mutateMaterials) options.mutateMaterials(materials, env);
  const materialsPath = path.join(root, "materials.json");
  writeJson(materialsPath, materials);

  env.paths = {
    pins: pinsPath,
    approval: approvalPath,
    materials: materialsPath,
    expectation: expectationPath,
    members: membersPath,
  };
  env.hashes = {
    pins: options.pinsSha ?? pinsSha,
    approval: options.approvalSha ?? approvalSha,
    materials: options.materialsSha ?? sha(fs.readFileSync(materialsPath)),
    expectation: options.expectationSha ?? sha(fs.readFileSync(expectationPath)),
    members: options.membersSha ?? sha(fs.readFileSync(membersPath)),
  };
  env.out = options.out ?? path.join(results, env.ticket);
  env.argv = [
    "preflight",
    "--ticket", env.ticket,
    "--pins", env.paths.pins,
    "--pins-sha256", env.hashes.pins,
    "--approval", env.paths.approval,
    "--approval-sha256", env.hashes.approval,
    "--materials", env.paths.materials,
    "--materials-sha256", env.hashes.materials,
    "--expectation", env.paths.expectation,
    "--expectation-sha256", env.hashes.expectation,
    "--members", env.paths.members,
    "--members-sha256", env.hashes.members,
    "--layout", layout,
    "--out", env.out,
  ];
  return env;
}

function run(env, overrides = {}) {
  return runPreflight({
    argv: overrides.argv ?? env.argv,
    cwd: env.root,
    io: overrides.io,
    now: overrides.now,
    hooks: overrides.hooks,
  });
}

function reportFile(env) {
  return path.join(env.out, "preflight-report.json");
}

function readReport(env) {
  return JSON.parse(fs.readFileSync(reportFile(env), "utf8"));
}

function incomplete(env) {
  return JSON.parse(fs.readFileSync(path.join(env.out, "INCOMPLETE.json"), "utf8"));
}

function copyMembers(env, raw) {
  fs.writeFileSync(env.paths.members, raw);
  env.hashes.members = sha(Buffer.from(raw));
  const index = env.argv.indexOf("--members-sha256");
  env.argv[index + 1] = env.hashes.members;
}

function setExternalHash(env, flag, value) {
  env.hashes[flag] = value;
  env.argv[env.argv.indexOf(`--${flag}-sha256`) + 1] = value;
}

// Close-failure injection that records only the actual output fds it opened,
// fails their production close, and can still close those own handles for real
// in a finally block. It never reports a production close success.
function closeFailingIo(env) {
  let outMade = false;
  const ownedFds = new Set();
  return {
    io: {
      mkdirSync(...args) {
        const result = fs.mkdirSync(...args);
        outMade = true;
        return result;
      },
      openSync(file, flags, ...rest) {
        const fd = fs.openSync(file, flags, ...rest);
        if (outMade && typeof file === "string" && (file === env.out || file.startsWith(`${env.out}${path.sep}`))) {
          ownedFds.add(fd);
        }
        return fd;
      },
      closeSync(fd) {
        if (ownedFds.has(fd)) throw new Error("injected close");
        return fs.closeSync(fd);
      },
    },
    release() {
      for (const fd of ownedFds) {
        try {
          fs.closeSync(fd);
        } catch {
          /* already closed by the production path */
        }
      }
      ownedFds.clear();
    },
  };
}

// Rewrites the real on-disk SHA256SUMS immediately after its rename, emulating
// the independent post-write corruption counterexample.
function sumsRewriteIo(env, rewrite) {
  return {
    renameSync(from, to) {
      const result = fs.renameSync(from, to);
      if (to === path.join(env.out, "SHA256SUMS")) {
        fs.writeFileSync(to, rewrite(fs.readFileSync(to, "utf8")), "utf8");
      }
      return result;
    },
  };
}

test("T1 合法合成全 PASS，三资格分离", () => {
  const env = makeEnv();
  const result = run(env);
  assert.equal(result.exitCode, 0);
  const report = readReport(env);
  assert.equal(report.evaluation.verdict, "PASS");
  assert.equal(report.evaluation.firstFailure, null);
  assert.deepEqual(report.evaluation.checkedPrefix, ["G0", "G1", "G2", "G4", "G5", "G6", "G3"]);
  assert.deepEqual(report.evaluation.notEvaluated, []);
  assert.equal(report.finalization.status, "COMPLETE");
  assert.equal(report.finalExit, 0);
  assert.equal(report.eligibility.build.status, "REFUSED");
  assert.equal(report.eligibility.execution.status, "REFUSED");
  assert.equal(report.eligibility.execution.code, "RELEASE_MEMBERS_LEGACY_EXECUTION_NOT_GRANTED");
  assert.equal(report.eligibility.install.code, "UNKNOWN_RUNTIME_NOT_MODELED");
  assert.ok(fs.existsSync(path.join(env.out, "SHA256SUMS")));
  assert.ok(!fs.existsSync(path.join(env.out, "INCOMPLETE.json")));
});

test("T2 pin sha 漂移 -> G2 REFUSED_IDENTITY_DRIFT exit10", () => {
  const env = makeEnv({
    mutatePins(pins) {
      pins.entries[0].sha256 = "f".repeat(64);
    },
  });
  const result = run(env);
  assert.equal(result.exitCode, 10);
  const report = readReport(env);
  assert.equal(report.evaluation.firstFailure, "REFUSED_IDENTITY_DRIFT");
  assert.deepEqual(report.evaluation.checkedPrefix, ["G0", "G1", "G2"]);
  assert.deepEqual(report.evaluation.notEvaluated, ["G4", "G5", "G6", "G3"]);
  assert.equal(report.finalization.status, "COMPLETE");
});

test("T3 pin bytes 漂移 -> G2 exit10", () => {
  const env = makeEnv({
    mutatePins(pins) {
      pins.entries[0].bytes += 1;
    },
  });
  assert.equal(run(env).exitCode, 10);
  assert.equal(readReport(env).evaluation.firstFailure, "REFUSED_IDENTITY_DRIFT");
});

test("T4 pin 指向目录/symlink -> G2 exit10 不跟随", () => {
  const dir = realTmp("mep-dir-");
  const env = makeEnv({
    mutatePins(pins, e) {
      pins.entries[0].path = dir;
      pins.entries[0].bytes = 1;
      pins.entries[0].sha256 = "a".repeat(64);
      const link = path.join(e.src, "link.py");
      try {
        fs.symlinkSync(path.join(e.src, "analyze.py"), link);
      } catch {
        /* symlink creation is best effort on this host */
      }
      pins.entries[1].path = link;
    },
  });
  assert.equal(run(env).exitCode, 10);
  assert.equal(readReport(env).evaluation.firstFailure, "REFUSED_IDENTITY_DRIFT");
});

test("T5 pins 外部 hash 错 -> G1 REFUSED_PINS exit10", () => {
  const env = makeEnv();
  env.hashes.pins = "0".repeat(64);
  env.argv[env.argv.indexOf("--pins-sha256") + 1] = env.hashes.pins;
  assert.equal(run(env).exitCode, 10);
  const report = readReport(env);
  assert.equal(report.evaluation.firstFailure, "REFUSED_PINS");
  assert.deepEqual(report.evaluation.checkedPrefix, ["G0", "G1"]);
});

test("T6a 缺任一必填 CLI -> exit2 无 out", () => {
  for (const flag of ["--approval-sha256", "--approval", "--members-sha256"]) {
    const env = makeEnv();
    const index = env.argv.indexOf(flag);
    const argv = env.argv.slice(0, index).concat(env.argv.slice(index + 2));
    const result = run(env, { argv });
    assert.equal(result.exitCode, 2);
    assert.match(result.stdout, /"finalExit":2/);
    assert.match(result.stdout, /"firstFailure":"REFUSED_USAGE"/);
    assert.ok(!fs.existsSync(env.out));
  }
});

test("T6b approval 输入齐但 hash 不符 -> G4 exit10 有可用报告", () => {
  const env = makeEnv();
  env.hashes.approval = "1".repeat(64);
  env.argv[env.argv.indexOf("--approval-sha256") + 1] = env.hashes.approval;
  assert.equal(run(env).exitCode, 10);
  const report = readReport(env);
  assert.equal(report.evaluation.firstFailure, "REFUSED_MATERIAL_AUTHORITY");
  assert.equal(report.finalization.status, "COMPLETE");
  assert.ok(fs.existsSync(path.join(env.out, "SHA256SUMS")));
});

test("T7 approval 越权 -> REFUSED_APPROVAL_SCOPE exit10", () => {
  for (const mutate of [
    (approval) => { approval.scope = "build"; },
    (approval) => { approval.buildAuthorized = true; },
  ]) {
    const env = makeEnv({ mutateApproval: mutate });
    assert.equal(run(env).exitCode, 10);
    assert.equal(readReport(env).evaluation.firstFailure, "REFUSED_APPROVAL_SCOPE");
  }
});

test("T8 材料集合不全/未知键 -> REFUSED_MATERIAL_SET exit10", () => {
  for (const mutate of [
    (approval) => { approval.requiredMaterialIds = []; },
    (approval) => { approval.requiredMaterialIds = approval.requiredMaterialIds.slice(1); },
    (approval) => { approval.requiredMaterialIds = [...approval.requiredMaterialIds, "extra.id"]; },
    (approval) => { approval.requiredMaterialIds = [approval.requiredMaterialIds[0], ...approval.requiredMaterialIds]; },
  ]) {
    const env = makeEnv({ mutateApproval: mutate });
    assert.equal(run(env).exitCode, 10);
    assert.equal(readReport(env).evaluation.firstFailure, "REFUSED_MATERIAL_SET");
  }
  const env = makeEnv({
    mutateMaterials(materials) {
      materials.items[0].licensed = true;
    },
  });
  assert.equal(run(env).exitCode, 10);
  assert.equal(readReport(env).evaluation.firstFailure, "REFUSED_MATERIAL_SET");
});

test("T9 MATCH 无证据/不在白名单/hash 不符/路径越界 -> REFUSED_MATERIAL_EVIDENCE", () => {
  const noRef = makeEnv({
    mutateMaterials(materials) {
      delete materials.items[0].evidenceRef;
    },
  });
  assert.equal(run(noRef).exitCode, 10);
  assert.equal(readReport(noRef).evaluation.firstFailure, "REFUSED_MATERIAL_EVIDENCE");

  const notAllowed = makeEnv({
    mutateMaterials(materials) {
      materials.items[0].evidenceRef = "evidence.unknown";
    },
  });
  assert.equal(run(notAllowed).exitCode, 10);
  assert.equal(readReport(notAllowed).evaluation.firstFailure, "REFUSED_MATERIAL_EVIDENCE");

  const badHash = makeEnv();
  const approval = JSON.parse(fs.readFileSync(badHash.paths.approval, "utf8"));
  approval.allowedEvidence[0].sha256 = "2".repeat(64);
  writeJson(badHash.paths.approval, approval);
  badHash.hashes.approval = sha(fs.readFileSync(badHash.paths.approval));
  badHash.argv[badHash.argv.indexOf("--approval-sha256") + 1] = badHash.hashes.approval;
  assert.equal(run(badHash).exitCode, 10);
  assert.equal(readReport(badHash).evaluation.firstFailure, "REFUSED_MATERIAL_EVIDENCE");

  const outside = makeEnv();
  const approval2 = JSON.parse(fs.readFileSync(outside.paths.approval, "utf8"));
  approval2.allowedEvidence[0].path = path.join(outside.root, "outside-evidence.txt");
  fs.writeFileSync(path.join(outside.root, "outside-evidence.txt"), "outside\n");
  approval2.allowedEvidence[0].sha256 = sha(fs.readFileSync(path.join(outside.root, "outside-evidence.txt")));
  writeJson(outside.paths.approval, approval2);
  outside.hashes.approval = sha(fs.readFileSync(outside.paths.approval));
  outside.argv[outside.argv.indexOf("--approval-sha256") + 1] = outside.hashes.approval;
  assert.equal(run(outside).exitCode, 10);
  assert.equal(readReport(outside).evaluation.firstFailure, "REFUSED_MATERIAL_EVIDENCE");
});

test("T10 材料状态未清 -> REFUSED_LICENSE_MATERIALS exit10", () => {
  const env = makeEnv({
    mutateMaterials(materials) {
      const statuses = ["UNKNOWN", "UNKNOWN", "OPEN", "OPEN", "GAP", "GAP", "GAP", "GAP", "GAP"];
      for (let i = 0; i < statuses.length; i += 1) materials.items[i].status = statuses[i];
    },
  });
  assert.equal(run(env).exitCode, 10);
  const report = readReport(env);
  assert.equal(report.evaluation.firstFailure, "REFUSED_LICENSE_MATERIALS");
  assert.equal(report.finalization.status, "COMPLETE");
});

test("T11 onedir 静态不兼容 -> G6 REFUSED_CONTRACT_STATIC exit10", () => {
  const env = makeEnv({
    layout: "onedir",
    mutateExpectation(expectation) {
      expectation.projection = {
        entries: 556,
        bytes: 322_016_619,
        symlinks: 5,
        maxFileBytes: 129_871_888,
        archiveBytes: 120_156_053,
        provenance: "static-toc-2026-10-26/NOT-A-BUILD-ARTIFACT",
      };
    },
  });
  assert.equal(run(env).exitCode, 10);
  const report = readReport(env);
  assert.equal(report.evaluation.firstFailure, "REFUSED_CONTRACT_STATIC");
  assert.deepEqual(report.evaluation.checkedPrefix, ["G0", "G1", "G2", "G4", "G5", "G6"]);
  assert.equal(report.eligibility.install.code, "REFUSED_STATIC_PROJECTION");
  assert.equal(report.eligibility.execution.code, "RELEASE_MEMBERS_LEGACY_EXECUTION_NOT_GRANTED");
});

test("T12 sidecar 两成员静态不兼容 -> G6 exit10", () => {
  const env = makeEnv({
    layout: "sidecar-two-member",
    membersFixture: "v1",
    mutateExpectation(expectation) {
      expectation.projection = {
        entries: 2,
        bytes: 210_558_863,
        symlinks: 0,
        maxFileBytes: 40_771_472,
        archiveBytes: 121_168_016,
        provenance: "static-arithmetic/NOT-BUILT",
      };
    },
  });
  assert.equal(run(env).exitCode, 10);
  const report = readReport(env);
  assert.equal(report.evaluation.firstFailure, "REFUSED_CONTRACT_STATIC");
  assert.equal(report.eligibility.install.code, "REFUSED_STATIC_PROJECTION");
  assert.equal(report.eligibility.execution.code, "RELEASE_MEMBERS_MULTI_MEMBER_EXECUTION_NOT_APPROVED");
});

test("T13 build/实测入口不存在 -> exit2", () => {
  for (const extra of [["build"], ["--build"], ["--authorization"], ["--measured-toc"]]) {
    const env = makeEnv();
    const argv = extra[0].startsWith("--")
      ? [...env.argv, extra[0], "x"]
      : ["build", ...env.argv.slice(1)];
    assert.equal(run(env, { argv }).exitCode, 2);
    assert.ok(!fs.existsSync(env.out));
  }
});

test("T14 有界读超限/条目超 64", () => {
  const env = makeEnv();
  const big = "x".repeat(LIMITS.jsonSingle + 16);
  fs.writeFileSync(env.paths.pins, big);
  env.hashes.pins = sha(fs.readFileSync(env.paths.pins));
  env.argv[env.argv.indexOf("--pins-sha256") + 1] = env.hashes.pins;
  assert.equal(run(env).exitCode, 11);
  assert.equal(readReport(env).evaluation.firstFailure, "UNKNOWN_READ_BUDGET");

  const env2 = makeEnv({
    mutatePins(pins, e) {
      const base = pins.entries[0];
      pins.entries = Array.from({ length: 65 }, (_, index) => ({
        ...base,
        id: `pin.${index}`,
        path: path.join(e.src, `pin-${index}.txt`),
      }));
      for (const entry of pins.entries) {
        fs.writeFileSync(entry.path, "x");
        entry.bytes = 1;
        entry.sha256 = sha(Buffer.from("x"));
      }
    },
  });
  assert.equal(run(env2).exitCode, 10);
  assert.equal(readReport(env2).evaluation.firstFailure, "REFUSED_PINS");
});

test("T15 收尾失败三例 -> exit12 无有效 SUMS", () => {
  const closeEnv = makeEnv();
  const closeCase = closeFailingIo(closeEnv);
  try {
    assert.equal(run(closeEnv, { io: closeCase.io }).exitCode, 12);
    const closeReport = incomplete(closeEnv);
    assert.equal(closeReport.finalization.code, "UNKNOWN_IO");
    assert.equal(closeReport.finalization.stage, "CLOSE");
    assert.equal(closeReport.finalization.reportUsable, false);
  } finally {
    closeCase.release();
  }

  const renameEnv = makeEnv();
  const renameIo = {
    renameSync() {
      throw new Error("injected rename");
    },
  };
  assert.equal(run(renameEnv, { io: renameIo }).exitCode, 12);
  const renameReport = incomplete(renameEnv);
  assert.equal(renameReport.finalization.code, "UNKNOWN_EVIDENCE");
  assert.equal(renameReport.finalization.stage, "RENAME");

  const checkEnv = makeEnv();
  const checkIo = {
    writeSync(fd, buffer, offset, length, position) {
      if (buffer.includes("shiguang-music-engine-preflight-report/v3")) {
        const copy = Buffer.from(buffer);
        copy[copy.length - 2] = copy[copy.length - 2] === 0x20 ? 0x21 : 0x20;
        return fs.writeSync(fd, copy, offset, length, position);
      }
      return fs.writeSync(fd, buffer, offset, length, position);
    },
  };
  assert.equal(run(checkEnv, { io: checkIo }).exitCode, 12);
  const checkReport = incomplete(checkEnv);
  assert.equal(checkReport.finalization.code, "UNKNOWN_EVIDENCE");
  assert.equal(checkReport.finalization.stage, "SELF_CHECK");
});

test("T16 工具链覆盖不全 -> G3 UNKNOWN exit11", () => {
  const env = makeEnv({
    mutateExpectation(expectation) {
      expectation.toolchainCoverage.declaredComplete = false;
      expectation.toolchainCoverage.categories.hooksCode = false;
    },
  });
  assert.equal(run(env).exitCode, 11);
  const report = readReport(env);
  assert.equal(report.evaluation.firstFailure, "UNKNOWN_TOOLCHAIN_COVERAGE");
  assert.deepEqual(report.evaluation.checkedPrefix, ["G0", "G1", "G2", "G4", "G5", "G6", "G3"]);
  assert.equal(report.finalization.status, "COMPLETE");
});

test("T17 输出路径/覆盖 -> exit2 不写", () => {
  const existed = makeEnv();
  fs.mkdirSync(existed.out);
  assert.equal(run(existed).exitCode, 2);
  assert.deepEqual(fs.readdirSync(existed.out), []);

  const wrong = makeEnv();
  const wrongOut = path.join(wrong.results, "OTHER-TICKET");
  wrong.argv[wrong.argv.indexOf("--out") + 1] = wrongOut;
  assert.equal(run(wrong).exitCode, 2);
  assert.ok(!fs.existsSync(wrongOut));

  const traversal = makeEnv();
  traversal.argv[traversal.argv.indexOf("--out") + 1] = `${traversal.results}/../escape`;
  assert.equal(run(traversal).exitCode, 2);
});

test("T18 checked-prefix 穷举/报告无绝对路径", () => {
  const refused = makeEnv({
    mutateMaterials(materials) {
      materials.items[0].status = "GAP";
    },
  });
  assert.equal(run(refused).exitCode, 10);
  const report = readReport(refused);
  assert.equal(report.evaluation.verdict, "REFUSED");
  assert.deepEqual(report.evaluation.checkedPrefix, ["G0", "G1", "G2", "G4"]);
  assert.deepEqual(report.evaluation.notEvaluated, ["G5", "G6", "G3"]);
  assert.ok(!JSON.stringify(report).includes(refused.root));

  const unknown = makeEnv({
    mutateExpectation(expectation) {
      expectation.toolchainCoverage.declaredComplete = false;
    },
  });
  assert.equal(run(unknown).exitCode, 11);
  const report2 = readReport(unknown);
  assert.equal(report2.evaluation.verdict, "UNKNOWN");
  assert.deepEqual(report2.evaluation.notEvaluated, []);
  assert.ok(!JSON.stringify(report2).includes(unknown.root));
});

test("T19a pending open 未 settle -> F SETTLE exit12", () => {
  const env = makeEnv();
  const pendingIo = {
    openSync(_file, flags, ...rest) {
      if (!(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR))) {
        const error = new Error("injected pending open");
        error.code = "ETESTPENDING";
        throw error;
      }
      return fs.openSync(_file, flags, ...rest);
    },
  };
  assert.equal(run(env, { io: pendingIo }).exitCode, 12);
  const report = incomplete(env);
  assert.equal(report.finalization.code, "UNKNOWN_IO");
  assert.equal(report.finalization.stage, "SETTLE");
  assert.ok(report.finalization.unsettledOperations >= 1);
});

test("T19b/c G0 越过 D_EVAL -> 11 或 12", () => {
  const validated = makeEnv();
  const clock1 = { t: 0 };
  assert.equal(
    run(validated, {
      now: () => clock1.t,
      hooks: {
        afterOutValidated() {
          clock1.t = LIMITS.evalMs + 1000;
        },
      },
    }).exitCode,
    11,
  );
  const validatedReport = readReport(validated);
  assert.equal(validatedReport.evaluation.firstFailure, "UNKNOWN_READ_DEADLINE");
  assert.deepEqual(validatedReport.evaluation.checkedPrefix, ["G0"]);

  const late = makeEnv();
  const clock2 = { t: 0 };
  assert.equal(
    run(late, {
      now: () => clock2.t,
      hooks: {
        beforeInputLstat() {
          clock2.t = LIMITS.evalMs + 1000;
        },
      },
    }).exitCode,
    12,
  );
});

test("T19d 输出 rename 越过 F_END -> F RENAME exit12，不再写诊断 IO", () => {
  const env = makeEnv();
  const clock = { t: 0 };
  let fEnd = 0;
  const io = {
    mkdirSync(...args) {
      const result = fs.mkdirSync(...args);
      fEnd = clock.t + LIMITS.finalMs;
      return result;
    },
    renameSync(...args) {
      const result = fs.renameSync(...args);
      clock.t = fEnd + 1000;
      return result;
    },
  };
  assert.equal(run(env, { io, now: () => clock.t }).exitCode, 12);
  // P2-3: the fixed F window is already over, so no INCOMPLETE diagnostic IO.
  assert.ok(!fs.existsSync(path.join(env.out, "INCOMPLETE.json")));
  assert.ok(fs.existsSync(path.join(env.out, "preflight-report.md.tmp")));
});

test("T19e late 真实 owned fd 仅真实 close 一次，不伪造 CLOSED", () => {
  const root = realTmp("mep-late-");
  const file = path.join(root, "owned.txt");
  fs.writeFileSync(file, "late-fixture\n");
  const fd = fs.openSync(file, "r");
  const clock = { t: 0 };
  const ledger = createLedger(() => clock.t);
  const op = ledger.begin("OPEN");
  ledger.settle(op);
  ledger.own(op, fd);
  let closes = 0;
  const ctx = {
    io: {
      closeSync(actualFd) {
        closes += 1;
        return fs.closeSync(actualFd);
      },
    },
    ledger,
    inFinalize: false,
    now: () => clock.t,
    fEnd: LIMITS.finalMs,
    closeFailed: 0,
  };
  clock.t = LIMITS.finalMs + 1;
  closeOwned(ctx, fd, op, "CLOSE", "UNKNOWN_IO");
  assert.equal(closes, 1);
  assert.equal(ledger.ops.filter((entry) => entry.kind === "CLOSE").length, 1);
  assert.equal(ledger.lateOwnedFds, 1);
  assert.equal(ledger.openCount(), 0);
  assert.throws(
    () => fs.fstatSync(fd),
    (error) => error.code === "EBADF",
  );
});

test("T19f close 失败保留 UNKNOWN 归属，只真实尝试一次", () => {
  const root = realTmp("mep-closefail-");
  const file = path.join(root, "owned.txt");
  fs.writeFileSync(file, "close-failure-fixture\n");
  const fd = fs.openSync(file, "r");
  const ledger = createLedger(() => 0);
  const op = ledger.begin("OPEN");
  ledger.settle(op);
  ledger.own(op, fd);
  let attempts = 0;
  const ctx = {
    io: {
      closeSync() {
        attempts += 1;
        throw new Error("injected close failure");
      },
    },
    ledger,
    inFinalize: true,
    now: () => 0,
    fEnd: LIMITS.finalMs,
    closeFailed: 0,
  };
  let failedCode = null;
  try {
    closeOwned(ctx, fd, op, "CLOSE", "UNKNOWN_IO");
  } catch (error) {
    failedCode = error.code;
  }
  assert.equal(failedCode, "UNKNOWN_IO");
  assert.equal(attempts, 1);
  assert.equal(ctx.closeFailed, 1);
  assert.equal(ledger.openCount(), 1);
  assert.equal(ledger.ownedOpen()[0].closeState, "CLOSE_FAILED");
  closeOwned(ctx, fd, op, "CLOSE", "UNKNOWN_IO");
  assert.equal(attempts, 1);
  fs.closeSync(fd);
});

test("T19g writeAll 首写返回即过期 -> 不再发第二写，exit12", () => {
  const env = makeEnv();
  const clock = { t: 0 };
  let writes = 0;
  let writesAfterDeadline = 0;
  const io = {
    writeSync(fd, buffer, offset, length, position) {
      if (clock.t >= LIMITS.finalMs) writesAfterDeadline += 1;
      const written = fs.writeSync(fd, buffer, offset, Math.min(length, 1), position);
      writes += 1;
      clock.t = LIMITS.finalMs + 1;
      return written;
    },
  };
  const result = run(env, { io, now: () => clock.t });
  assert.equal(result.exitCode, 12);
  assert.equal(writes, 1);
  assert.equal(writesAfterDeadline, 0);
  assert.equal(result.ledgerSummary.byKind.WRITE, 1);
  assert.equal(result.ledgerSummary.pending, 0);
  assert.ok(!fs.existsSync(path.join(env.out, "INCOMPLETE.json")));
});

test("T19h 正常短写仍完整写完全部输出", () => {
  const env = makeEnv();
  let writes = 0;
  const io = {
    writeSync(fd, buffer, offset, length, position) {
      writes += 1;
      return fs.writeSync(fd, buffer, offset, Math.min(length, 3), position);
    },
  };
  const result = run(env, { io });
  assert.equal(result.exitCode, 0);
  assert.ok(writes > 20);
  assert.ok(fs.existsSync(path.join(env.out, "SHA256SUMS")));
});

test("T19i INCOMPLETE 诊断短写返回即过期 -> 不再发第二写，partial 保留", () => {
  const env = makeEnv();
  const clock = { t: 0 };
  let diagFd = null;
  let renames = 0;
  let diagWrites = 0;
  let diagWritesAfterDeadline = 0;
  const io = {
    mkdirSync(...args) {
      return fs.mkdirSync(...args);
    },
    openSync(file, flags, ...rest) {
      const fd = fs.openSync(file, flags, ...rest);
      if (typeof file === "string" && file.endsWith("INCOMPLETE.json")) diagFd = fd;
      return fd;
    },
    renameSync(from, to) {
      renames += 1;
      if (renames === 1) throw new Error("injected rename failure");
      return fs.renameSync(from, to);
    },
    writeSync(fd, buffer, offset, length, position) {
      if (fd === diagFd) {
        if (clock.t >= LIMITS.finalMs) diagWritesAfterDeadline += 1;
        const written = fs.writeSync(fd, buffer, offset, Math.min(length, 1), position);
        diagWrites += 1;
        clock.t = LIMITS.finalMs + 1;
        return written;
      }
      return fs.writeSync(fd, buffer, offset, length, position);
    },
  };
  const result = run(env, { io, now: () => clock.t });
  assert.equal(result.exitCode, 12);
  assert.equal(diagWrites, 1);
  assert.equal(diagWritesAfterDeadline, 0);
  const partial = path.join(env.out, "INCOMPLETE.json");
  assert.ok(fs.existsSync(partial));
  assert.equal(fs.statSync(partial).size, 1);
});

test("T19j finalizer fstat 返回即过期 -> 不再继续读，exit12", () => {
  const env = makeEnv();
  const clock = { t: 0 };
  let armed = false;
  let finalFstats = 0;
  let readsAfterDeadline = 0;
  const io = {
    renameSync(from, to) {
      const result = fs.renameSync(from, to);
      if (to.endsWith("SHA256SUMS")) armed = true;
      return result;
    },
    fstatSync(fd) {
      const stat = fs.fstatSync(fd);
      if (armed) {
        finalFstats += 1;
        clock.t = LIMITS.finalMs + 1;
      }
      return stat;
    },
    readSync(fd, buffer, offset, length, position) {
      if (clock.t >= LIMITS.finalMs) readsAfterDeadline += 1;
      return fs.readSync(fd, buffer, offset, length, position);
    },
  };
  const result = run(env, { io, now: () => clock.t });
  assert.equal(result.exitCode, 12);
  assert.equal(finalFstats, 1);
  assert.equal(readsAfterDeadline, 0);
  assert.ok(!fs.existsSync(path.join(env.out, "INCOMPLETE.json")));
});

test("T19k finalizer fsync 返回即过期 -> 不再发后续写，exit12", () => {
  const env = makeEnv();
  const clock = { t: 0 };
  let fsyncs = 0;
  let writesAfterDeadline = 0;
  const io = {
    fsyncSync(fd) {
      const result = fs.fsyncSync(fd);
      fsyncs += 1;
      if (fsyncs === 1) clock.t = LIMITS.finalMs + 1;
      return result;
    },
    writeSync(fd, buffer, offset, length, position) {
      if (clock.t >= LIMITS.finalMs) writesAfterDeadline += 1;
      return fs.writeSync(fd, buffer, offset, length, position);
    },
  };
  const result = run(env, { io, now: () => clock.t });
  assert.equal(result.exitCode, 12);
  assert.equal(fsyncs, 1);
  assert.equal(writesAfterDeadline, 0);
  assert.ok(!fs.existsSync(path.join(env.out, "SHA256SUMS")));
  assert.ok(!fs.existsSync(path.join(env.out, "INCOMPLETE.json")));
});

test("T19l owned close 返回即过期 -> 记 LATE、只 close 一次、不再输出", () => {
  const env = makeEnv();
  const clock = { t: 0 };
  let armed = false;
  let closes = 0;
  let writesAfterDeadline = 0;
  const io = {
    mkdirSync(...args) {
      const result = fs.mkdirSync(...args);
      armed = true;
      return result;
    },
    closeSync(fd) {
      const result = fs.closeSync(fd);
      if (armed) {
        closes += 1;
        if (closes === 1) clock.t = LIMITS.finalMs + 1;
      }
      return result;
    },
    writeSync(fd, buffer, offset, length, position) {
      if (clock.t >= LIMITS.finalMs) writesAfterDeadline += 1;
      return fs.writeSync(fd, buffer, offset, length, position);
    },
  };
  const result = run(env, { io, now: () => clock.t });
  assert.equal(result.exitCode, 12);
  assert.equal(closes, 1);
  assert.equal(writesAfterDeadline, 0);
  assert.ok(result.ledgerSummary.lateOwnedFds >= 1);
  assert.ok(!fs.existsSync(path.join(env.out, "INCOMPLETE.json")));
});

test("T20 finalexit 唯一矩阵", () => {
  const renameEnv = makeEnv({
    mutateMaterials(materials) {
      materials.items[0].status = "GAP";
    },
  });
  const renameIo = { renameSync() { throw new Error("rename"); } };
  assert.equal(run(renameEnv, { io: renameIo }).exitCode, 12);
  const incompleteReport = incomplete(renameEnv);
  assert.equal(incompleteReport.evaluation.firstFailure, "REFUSED_LICENSE_MATERIALS");
  assert.equal(incompleteReport.finalization.stage, "RENAME");

  const refusedEnv = makeEnv({
    mutateMaterials(materials) {
      materials.items[0].status = "GAP";
    },
  });
  assert.equal(run(refusedEnv).exitCode, 10);

  const unknownEnv = makeEnv({
    mutateExpectation(expectation) {
      expectation.toolchainCoverage.declaredComplete = false;
    },
  });
  assert.equal(run(unknownEnv).exitCode, 11);

  const usageEnv = makeEnv();
  const index = usageEnv.argv.indexOf("--approval-sha256");
  const usageArgv = usageEnv.argv.slice(0, index).concat(usageEnv.argv.slice(index + 2));
  assert.equal(run(usageEnv, { argv: usageArgv }).exitCode, 2);

  const closeEnv = makeEnv();
  const closeCase = closeFailingIo(closeEnv);
  try {
    assert.equal(run(closeEnv, { io: closeCase.io }).exitCode, 12);
    assert.equal(incomplete(closeEnv).finalization.code, "UNKNOWN_IO");
  } finally {
    closeCase.release();
  }
});

test("T21 成员 4 KiB 上限优先 -> G5 REFUSED_DECLARATION exit10", () => {
  const env = makeEnv({ padMembers: 5000 });
  assert.equal(run(env).exitCode, 10);
  const report = readReport(env);
  assert.equal(report.evaluation.firstFailure, "REFUSED_DECLARATION");
  assert.deepEqual(report.evaluation.checkedPrefix, ["G0", "G1", "G2", "G4", "G5"]);
});

test("T22 三外部 pin 负例：materials/expectation/members 原始 buffer 真比对", () => {
  const baseline = makeEnv();
  assert.equal(run(baseline).exitCode, 0);

  const cases = [
    { flag: "materials", code: "REFUSED_MATERIAL_SET", prefix: ["G0", "G1", "G2", "G4"] },
    { flag: "expectation", code: "REFUSED_EXPECTATION", prefix: ["G0", "G1", "G2", "G4", "G5"] },
    { flag: "members", code: "REFUSED_DECLARATION", prefix: ["G0", "G1", "G2", "G4", "G5"] },
  ];
  for (const spec of cases) {
    const env = makeEnv();
    // Negative case changes only its own external pin to 64 zeroes; the expected
    // value is never derived from the input bytes.
    setExternalHash(env, spec.flag, "0".repeat(64));
    const result = run(env);
    assert.equal(result.exitCode, 10, spec.flag);
    const report = readReport(env);
    assert.equal(report.evaluation.firstFailure, spec.code, spec.flag);
    assert.deepEqual(report.evaluation.checkedPrefix, spec.prefix, spec.flag);
    assert.equal(report.finalization.status, "COMPLETE", spec.flag);
    assert.ok(fs.existsSync(path.join(env.out, "SHA256SUMS")), spec.flag);
  }
});

test("T23 落盘 SHA256SUMS 被改短/改坏/重复名 -> F SELF_CHECK exit12 保残留", () => {
  const variants = [
    {
      name: "short-corrupted",
      rewrite: () => "corrupted independent checksum manifest\n",
    },
    {
      name: "wrong-hex-line",
      rewrite: (text) => text.replace(/^[0-9a-f]{64}/, "0".repeat(64)),
    },
    {
      name: "duplicate-name",
      rewrite: (text) => {
        const lines = text.trimEnd().split("\n");
        lines[2] = lines[0];
        return `${lines.join("\n")}\n`;
      },
    },
  ];
  for (const variant of variants) {
    const env = makeEnv();
    const written = [];
    const io = sumsRewriteIo(env, (text) => {
      const next = variant.rewrite(text);
      written.push(next);
      return next;
    });
    assert.equal(run(env, { io }).exitCode, 12, variant.name);
    const report = incomplete(env);
    assert.equal(report.finalization.code, "UNKNOWN_EVIDENCE", variant.name);
    assert.equal(report.finalization.stage, "SELF_CHECK", variant.name);
    assert.equal(report.finalization.reportUsable, false, variant.name);
    const sumsPath = path.join(env.out, "SHA256SUMS");
    assert.ok(fs.existsSync(sumsPath), variant.name);
    // Corrupted manifest is retained as written; it is not deleted or rewritten.
    assert.equal(fs.readFileSync(sumsPath, "utf8"), written[0], variant.name);
  }
});

test("真实 CLI 进程 exit 与报告 finalExit 一致", () => {
  const env = makeEnv();
  const child = spawnSync(process.execPath, [SCRIPT, ...env.argv], {
    cwd: env.root,
    encoding: "utf8",
    timeout: CHILD_TIMEOUT_MS,
    maxBuffer: CHILD_MAX_BUFFER,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, child.stderr);
  const report = readReport(env);
  assert.equal(report.finalExit, child.status);
  assert.equal(report.finalization.status, "COMPLETE");

  const usageEnv = makeEnv();
  const index = usageEnv.argv.indexOf("--approval-sha256");
  const usageArgv = usageEnv.argv.slice(0, index).concat(usageEnv.argv.slice(index + 2));
  const usageChild = spawnSync(process.execPath, [SCRIPT, ...usageArgv], {
    cwd: usageEnv.root,
    encoding: "utf8",
    timeout: CHILD_TIMEOUT_MS,
    maxBuffer: CHILD_MAX_BUFFER,
  });
  assert.equal(usageChild.error, undefined);
  assert.equal(usageChild.signal, null);
  assert.equal(usageChild.status, 2);
  assert.match(usageChild.stdout, /"firstFailure":"REFUSED_USAGE"/);
});

test("入口源码零 child_process/net/http，无 build/measured 入口", () => {
  const source = fs.readFileSync(SCRIPT, "utf8");
  assert.ok(!source.includes("node:child_process"));
  assert.ok(!source.includes("node:net"));
  assert.ok(!source.includes("node:http"));
  assert.ok(!/\bspawn\s*\(/.test(source));
  assert.ok(!/\bexecSync\s*\(/.test(source));
  assert.ok(!/\bexecFile/.test(source));
  assert.ok(!source.includes("--measured-toc"));
  assert.ok(!source.includes("--build"));
  assert.ok(source.includes("preflight-only ticket"));
});
