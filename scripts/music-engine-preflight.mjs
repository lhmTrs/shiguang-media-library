#!/usr/bin/env node
/**
 * MUSIC-ENGINE-PREFLIGHT-IMPL-20261027
 *
 * 唯一的 preflight 入口：有界只读证据检查，零子进程、零网络、零 import 插件 Python。
 * 规范源：collab/results/MUSIC-ENGINE-BUILD-ENTRY-DESIGN-01-20261027/round3/CONTRACT-R3.md
 * 总监实施票：#0324（解释 1–4）。
 *
 * 本文件只 import 纯成员合同 server/audio-release-members.mjs；不修改它。
 * 不执行 build / PyInstaller / Python / hooks / 模型 / 真实素材。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  parseReleaseMembers,
  checkExternalExpectation,
  executionEligibility,
} from "../server/audio-release-members.mjs";

const MiB = 1024 * 1024;

export const LIMITS = Object.freeze({
  jsonSingle: 1 * MiB,
  jsonTotal: 4 * MiB,
  pinEntries: 64,
  pinFile: 160 * MiB,
  pinTotal: 512 * MiB,
  evidenceFiles: 11,
  evidenceFile: 2 * MiB,
  evidenceTotal: 8 * MiB,
  fdMax: 80,
  block: 1 * MiB,
  evalMs: 115_000,
  totalMs: 120_000,
  finalMs: 5_000,
  reportBytes: 64 * 1024,
  incompleteBytes: 4 * 1024,
  sumsBytes: 1024,
});

export const REQUIRED_MATERIAL_IDS = Object.freeze([
  "contract.distribution-notice",
  "lib.cpython",
  "lib.libomp",
  "lib.onnxruntime",
  "lib.openssl",
  "lib.sndfile",
  "lib.soxr",
  "model.musicnn.weights",
  "model.yamnet.classmap",
  "model.yamnet.weights",
  "plugin.license",
]);

export const GATE_ORDER = Object.freeze(["G0", "G1", "G2", "G4", "G5", "G6", "G3"]);
const ROLES = new Set(["source", "model", "toolchain", "runtime", "contract"]);
const LAYOUTS = new Set(["legacy-onefile", "onedir", "sidecar-two-member"]);
const MATERIAL_STATUS = new Set(["MATCH", "UNKNOWN", "OPEN", "GAP"]);
const SHA256_RE = /^[0-9a-f]{64}$/;
const TICKET_RE = /^[A-Z0-9][A-Z0-9-]{2,79}$/;
const CLI_FLAGS = Object.freeze([
  "ticket",
  "pins",
  "pins-sha256",
  "approval",
  "approval-sha256",
  "materials",
  "materials-sha256",
  "expectation",
  "expectation-sha256",
  "members",
  "members-sha256",
  "layout",
  "out",
]);
const FLAG_SET = new Set(CLI_FLAGS);

class UsageError extends Error {
  constructor(code = "REFUSED_USAGE") {
    super(code);
    this.code = code;
  }
}
class PathError extends Error {
  constructor(code = "REFUSED_PATH") {
    super(code);
    this.code = code;
  }
}
class GateError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
class BudgetError extends Error {
  constructor(code = "UNKNOWN_READ_BUDGET") {
    super(code);
    this.code = code;
  }
}
class DeadlineError extends Error {
  constructor(code = "UNKNOWN_READ_DEADLINE") {
    super(code);
    this.code = code;
  }
}
class SourceIoError extends Error {
  constructor() {
    super("UNKNOWN_SOURCE_IO");
    this.code = "UNKNOWN_SOURCE_IO";
  }
}
class FinalizeError extends Error {
  constructor(stage, code) {
    super(`${stage}/${code}`);
    this.stage = stage;
    this.code = code;
  }
}

const BASE_IO = Object.freeze({
  lstatSync: fs.lstatSync.bind(fs),
  realpathSync: fs.realpathSync.bind(fs),
  openSync: fs.openSync.bind(fs),
  fstatSync: fs.fstatSync.bind(fs),
  readSync: fs.readSync.bind(fs),
  closeSync: fs.closeSync.bind(fs),
  mkdirSync: fs.mkdirSync.bind(fs),
  writeSync: fs.writeSync.bind(fs),
  fsyncSync: fs.fsyncSync.bind(fs),
  renameSync: fs.renameSync.bind(fs),
});

export function createLedger(now = () => globalThis.performance.now()) {
  const ops = [];
  const owned = new Map();
  let nextId = 1;
  const ledger = {
    ops,
    lateOwnedFds: 0,
    begin(kind) {
      const op = {
        opId: nextId,
        kind,
        state: "PENDING",
        issueAt: now(),
        settleAt: null,
        ownsFd: false,
        closeState: "NOT_OWNED",
      };
      nextId += 1;
      ops.push(op);
      return op;
    },
    settle(op) {
      op.state = "SETTLED_OK";
      op.settleAt = now();
    },
    fail(op) {
      op.state = "SETTLED_ERR";
      op.settleAt = now();
    },
    leavePending(op) {
      op.state = "PENDING";
      op.settleAt = null;
    },
    own(op, fd) {
      op.ownsFd = true;
      op.closeState = "OPEN";
      owned.set(fd, op);
    },
    close(fd, ok) {
      const op = owned.get(fd);
      if (!op) return;
      if (ok) {
        op.closeState = "CLOSED";
        owned.delete(fd);
      } else {
        // Failed close is an UNKNOWN ownership fact: keep the fd owned so it is
        // never reported as closed, and never retry a real close on it.
        op.closeState = "CLOSE_FAILED";
        op.closeAttempts = (op.closeAttempts ?? 0) + 1;
      }
    },
    closed(fd, late) {
      const op = owned.get(fd);
      if (!op) return;
      op.closeState = "CLOSED";
      if (late) {
        op.state = "LATE";
        ledger.lateOwnedFds += 1;
      }
      owned.delete(fd);
    },
    canClose(fd) {
      const op = owned.get(fd);
      return Boolean(op) && op.closeState === "OPEN";
    },
    pending() {
      return ops.filter((op) => op.state === "PENDING");
    },
    ownedOpen() {
      return [...owned.values()];
    },
    openCount() {
      return owned.size;
    },
    isOwned(fd) {
      return owned.has(fd);
    },
  };
  return ledger;
}

export function computeFinalExit(g0Refused, evaluation, finalization) {
  if (g0Refused) return 2;
  if (!finalization || finalization.status !== "COMPLETE") return 12;
  if (evaluation.firstFailure === null) return 0;
  if (evaluation.firstFailure.startsWith("REFUSED_")) return 10;
  if (evaluation.firstFailure.startsWith("UNKNOWN_")) return 11;
  return 12;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkKeys(value, required, optional, code) {
  if (!isRecord(value)) throw new GateError(code);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new GateError(code);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw new GateError(code);
  }
  return value;
}

function parseCli(argv) {
  if (!Array.isArray(argv) || argv[0] !== "preflight") throw new UsageError();
  const seen = new Set();
  const values = {};
  let index = 1;
  while (index < argv.length) {
    const token = argv[index];
    if (typeof token !== "string" || !token.startsWith("--")) throw new UsageError();
    const name = token.slice(2);
    if (!FLAG_SET.has(name) || seen.has(name)) throw new UsageError();
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) throw new UsageError();
    seen.add(name);
    values[name] = value;
    index += 2;
  }
  for (const name of CLI_FLAGS) {
    if (!seen.has(name)) throw new UsageError();
  }
  if (!TICKET_RE.test(values.ticket)) throw new UsageError();
  if (!LAYOUTS.has(values.layout)) throw new UsageError();
  for (const name of ["pins-sha256", "approval-sha256", "materials-sha256", "expectation-sha256", "members-sha256"]) {
    if (!SHA256_RE.test(values[name])) throw new UsageError();
  }
  for (const name of ["pins", "approval", "materials", "expectation", "members", "out"]) {
    if (!path.isAbsolute(values[name])) throw new UsageError();
  }
  return values;
}

function isForbiddenOut(outPath, cwd) {
  const normalized = outPath.split(path.sep).join("/");
  const home = process.env.HOME ? process.env.HOME.split(path.sep).join("/") : null;
  if (/拾光云端后台/.test(normalized)) return true;
  if (normalized.includes("/.dsh/profiles/") || normalized.includes("dsh-soundcheck")) return true;
  if (home) {
    if (normalized === home) return true;
    if (normalized.startsWith(`${home}/Library/`)) return true;
  }
  if (normalized === cwd.split(path.sep).join("/")) return true;
  return false;
}

function checkG0Path(ctx) {
  const { io, opts } = ctx;
  ctx.checkEval();
  let realCwd;
  try {
    realCwd = io.realpathSync(opts.cwd);
  } catch {
    throw new PathError();
  }
  ctx.checkEval();
  if (realCwd !== opts.cwd) throw new PathError();
  const resultsDir = path.join(opts.cwd, "collab", "results");
  const expectedOut = path.join(resultsDir, opts.ticket);
  if (opts.out !== expectedOut) throw new PathError();
  if (opts.out.includes(`${path.sep}..${path.sep}`) || opts.out.endsWith(`${path.sep}..`)) throw new PathError();
  if (isForbiddenOut(opts.out, opts.cwd)) throw new PathError();

  ctx.checkEval();
  let resultsStat;
  try {
    resultsStat = io.lstatSync(resultsDir);
  } catch {
    throw new PathError();
  }
  ctx.checkEval();
  if (!resultsStat.isDirectory() || resultsStat.isSymbolicLink()) throw new PathError();
  let resultsReal;
  try {
    resultsReal = io.realpathSync(resultsDir);
  } catch {
    throw new PathError();
  }
  ctx.checkEval();
  if (resultsReal !== resultsDir) throw new PathError();

  ctx.checkEval();
  try {
    io.lstatSync(opts.out);
    throw new PathError();
  } catch (error) {
    if (error instanceof PathError) throw error;
    if (error && error.code !== "ENOENT") throw new PathError();
  }
  ctx.checkEval();

  for (const name of ["pins", "approval", "materials", "expectation", "members"]) {
    ctx.hooks.beforeInputLstat?.();
    ctx.checkEval();
    let stat;
    try {
      stat = io.lstatSync(opts[name]);
    } catch {
      throw new PathError();
    }
    ctx.checkEval();
    if (!stat.isFile() || stat.isSymbolicLink()) throw new PathError();
  }
  ctx.outValidated = true;
  ctx.hooks.afterOutValidated?.();
  ctx.checkEval();
}

function evalCheck(ctx) {
  if (ctx.now() >= ctx.dEval) throw new DeadlineError();
  if (ctx.ledger.pending().length > 0) throw new DeadlineError();
}

function evalChecked(ctx, operation) {
  evalCheck(ctx);
  const result = operation();
  if (ctx.now() >= ctx.dEval) throw new DeadlineError();
  return result;
}

function beginEvalOp(ctx, kind) {
  evalCheck(ctx);
  return ctx.ledger.begin(kind);
}

function beginF(ctx, kind, stage = kind, code = "UNKNOWN_EVIDENCE") {
  if (ctx.now() >= ctx.fEnd) throw new FinalizeError(stage, code);
  return ctx.ledger.begin(kind);
}

function afterF(ctx, stage, code = "UNKNOWN_EVIDENCE") {
  if (ctx.now() >= ctx.fEnd) throw new FinalizeError(stage, code);
}

export function closeOwned(ctx, fd, op, stage, code) {
  // Exactly one real close attempt per owned fd. A failed or late close is kept
  // as a truthful UNKNOWN ownership fact; it is never deleted to fake closure.
  if (!ctx.ledger.canClose(fd)) return;
  const expiredBefore = ctx.now() >= ctx.fEnd;
  const closeOp = ctx.ledger.begin("CLOSE");
  try {
    ctx.io.closeSync(fd);
  } catch {
    ctx.ledger.fail(closeOp);
    ctx.ledger.close(fd, false);
    ctx.closeFailed += 1;
    if (ctx.inFinalize) throw new FinalizeError(stage, "UNKNOWN_IO");
    return;
  }
  ctx.ledger.settle(closeOp);
  // Observe the clock after the actual close as well: an owned late descriptor
  // gets exactly this one settlement, which never authorizes further output.
  const late = expiredBefore || ctx.now() >= ctx.fEnd;
  ctx.ledger.closed(fd, late);
  if (late && ctx.inFinalize) throw new FinalizeError(stage, code);
}

function readBounded(ctx, filePath, config) {
  const { io, ledger } = ctx;
  const { singleMax, totalMax, totalUsed, counterKey, identity } = config;
  if (ctx.now() >= ctx.dEval) throw new DeadlineError();
  let stat;
  try {
    stat = io.lstatSync(filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") throw new GateError("REFUSED_IDENTITY_DRIFT");
    throw new SourceIoError();
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new GateError("REFUSED_IDENTITY_DRIFT");
  if (stat.size > singleMax) throw new BudgetError("UNKNOWN_READ_BUDGET");
  if (totalUsed + stat.size > totalMax) throw new BudgetError("UNKNOWN_READ_BUDGET");

  const openOp = beginEvalOp(ctx, "OPEN");
  let fd;
  try {
    fd = io.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if (error && error.code === "ETESTPENDING") {
      ledger.leavePending(openOp);
      throw error;
    }
    ledger.fail(openOp);
    if (error && error.code === "ENOENT") throw new GateError("REFUSED_IDENTITY_DRIFT");
    throw new SourceIoError();
  }
  ledger.settle(openOp);
  ledger.own(openOp, fd);
  if (ledger.openCount() > LIMITS.fdMax) {
    closeOwned(ctx, fd, openOp, "CLOSE", "UNKNOWN_IO");
    throw new BudgetError("UNKNOWN_READ_BUDGET");
  }

  try {
    let fstat;
    try {
      fstat = io.fstatSync(fd);
    } catch {
      throw new SourceIoError();
    }
    if (fstat.dev !== stat.dev || fstat.ino !== stat.ino || fstat.size !== stat.size) {
      throw new GateError("REFUSED_IDENTITY_DRIFT");
    }
    const chunks = [];
    let offset = 0;
    while (offset < stat.size) {
      const toRead = Math.min(LIMITS.block, stat.size - offset);
      const buffer = Buffer.allocUnsafe(toRead);
      const readOp = beginEvalOp(ctx, "READ");
      let bytesRead;
      try {
        bytesRead = io.readSync(fd, buffer, 0, toRead, offset);
      } catch {
        ledger.fail(readOp);
        throw new SourceIoError();
      }
      ledger.settle(readOp);
      if (bytesRead <= 0) throw new SourceIoError();
      chunks.push(buffer.subarray(0, bytesRead));
      offset += bytesRead;
      if (ctx.now() >= ctx.dEval) throw new DeadlineError();
    }
    let after;
    try {
      after = io.lstatSync(filePath);
    } catch {
      throw new GateError("REFUSED_IDENTITY_DRIFT");
    }
    const e = after;
    if (!e.isFile() || e.isSymbolicLink() || e.dev !== stat.dev || e.ino !== stat.ino || e.size !== stat.size) {
      throw new GateError("REFUSED_IDENTITY_DRIFT");
    }
    const data = Buffer.concat(chunks, offset);
    if (identity && identity.bytes !== undefined && identity.bytes !== data.length) {
      throw new GateError("REFUSED_IDENTITY_DRIFT");
    }
    if (counterKey) ctx[`${counterKey}Used`] += data.length;
    return data;
  } finally {
    closeOwned(ctx, fd, openOp, "CLOSE", "UNKNOWN_IO");
  }
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// P2-1: bind the actual raw bytes just read to the caller's external CLI pin
// before the value is parsed or used. The expected value is never derived from
// the input itself; a mismatch is a gate-specific refusal, not an echo.
function verifyInputPin(ctx, key, flag, code) {
  const bytes = ctx.inputBytes[key];
  if (!bytes || !Buffer.isBuffer(bytes)) throw new GateError(code);
  if (sha256(bytes) !== ctx.opts[flag]) throw new GateError(code);
}

function readJson(ctx, filePath, key, gateCode) {
  const remaining = ctx.jsonTotalUsed;
  let data;
  try {
    data = readBounded(ctx, filePath, {
      singleMax: LIMITS.jsonSingle,
      totalMax: LIMITS.jsonTotal,
      totalUsed: remaining,
      counterKey: "jsonTotal",
    });
  } catch (error) {
    if (error instanceof BudgetError) throw error;
    if (error instanceof DeadlineError) throw error;
    if (error instanceof GateError && error.code === "REFUSED_IDENTITY_DRIFT") throw new GateError(gateCode);
    throw error;
  }
  ctx.inputBytes[key] = data;
  try {
    return JSON.parse(data.toString("utf8"));
  } catch {
    throw new GateError(gateCode);
  }
}

function gateG1(ctx) {
  const pins = readJson(ctx, ctx.opts.pins, "pins", "REFUSED_PINS");
  checkKeys(pins, ["schema", "entries"], [], "REFUSED_PINS");
  if (pins.schema !== "shiguang-music-engine-build-pins/v1") throw new GateError("REFUSED_PINS");
  if (!Array.isArray(pins.entries) || pins.entries.length < 1 || pins.entries.length > LIMITS.pinEntries) {
    throw new GateError("REFUSED_PINS");
  }
  const ids = new Set();
  const paths = new Set();
  const seen = [];
  for (const entry of pins.entries) {
    checkKeys(entry, ["id", "role", "path", "bytes", "sha256", "required"], [], "REFUSED_PINS");
    if (typeof entry.id !== "string" || entry.id.length === 0 || ids.has(entry.id)) throw new GateError("REFUSED_PINS");
    if (typeof entry.path !== "string" || !path.isAbsolute(entry.path) || paths.has(entry.path)) {
      throw new GateError("REFUSED_PINS");
    }
    if (!ROLES.has(entry.role)) throw new GateError("REFUSED_PINS");
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) throw new GateError("REFUSED_PINS");
    if (typeof entry.sha256 !== "string" || !SHA256_RE.test(entry.sha256)) throw new GateError("REFUSED_PINS");
    if (entry.required !== true) throw new GateError("REFUSED_PINS");
    ids.add(entry.id);
    paths.add(entry.path);
    seen.push(entry);
  }
  const actual = ctx.inputBytes.pins;
  if (!actual || sha256(actual) !== ctx.opts["pins-sha256"]) throw new GateError("REFUSED_PINS");
  ctx.pins = seen;
  return { entries: seen.length };
}

function gateG2(ctx) {
  let checked = 0;
  let bytesRead = 0;
  for (const pin of ctx.pins) {
    const data = readBounded(ctx, pin.path, {
      singleMax: LIMITS.pinFile,
      totalMax: LIMITS.pinTotal,
      totalUsed: ctx.pinBytesUsed,
      counterKey: "pinBytes",
      identity: pin,
    });
    if (data.length !== pin.bytes || sha256(data) !== pin.sha256) {
      throw new GateError("REFUSED_IDENTITY_DRIFT");
    }
    checked += 1;
    bytesRead += data.length;
  }
  return { entriesChecked: checked, bytesRead };
}

function materialIdSet(items, code) {
  if (!Array.isArray(items)) throw new GateError(code);
  const ids = [];
  for (const item of items) {
    checkKeys(item, ["id", "status", "locator"], ["evidenceRef"], code);
    if (typeof item.id !== "string" || typeof item.status !== "string" || !MATERIAL_STATUS.has(item.status)) {
      throw new GateError(code);
    }
    if (typeof item.locator !== "string" || item.locator.length === 0) throw new GateError(code);
    if (item.evidenceRef !== undefined && typeof item.evidenceRef !== "string") throw new GateError(code);
    ids.push(item.id);
  }
  return ids;
}

function equalIdSets(actual, expected) {
  if (actual.length !== expected.length) return false;
  if (new Set(actual).size !== actual.length) return false;
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  return sortedActual.every((id, index) => id === sortedExpected[index]);
}

function gateG4(ctx) {
  const approval = readJson(ctx, ctx.opts.approval, "approval", "REFUSED_MATERIAL_AUTHORITY");
  if (!ctx.inputBytes.approval || sha256(ctx.inputBytes.approval) !== ctx.opts["approval-sha256"]) {
    throw new GateError("REFUSED_MATERIAL_AUTHORITY");
  }
  checkKeys(
    approval,
    ["schema", "approvalId", "ticket", "scope", "buildAuthorized", "requiredMaterialIds", "allowedEvidence"],
    ["issuedBy"],
    "REFUSED_MATERIAL_AUTHORITY",
  );
  if (approval.schema !== "shiguang-music-engine-preflight-approval/v1") {
    throw new GateError("REFUSED_MATERIAL_AUTHORITY");
  }
  if (typeof approval.approvalId !== "string" || approval.approvalId.length === 0) {
    throw new GateError("REFUSED_MATERIAL_AUTHORITY");
  }
  if (approval.ticket !== ctx.opts.ticket) throw new GateError("REFUSED_MATERIAL_AUTHORITY");
  if (approval.scope !== "preflight" || approval.buildAuthorized !== false) {
    throw new GateError("REFUSED_APPROVAL_SCOPE");
  }
  if (!equalIdSets(Array.isArray(approval.requiredMaterialIds) ? approval.requiredMaterialIds : [], REQUIRED_MATERIAL_IDS)) {
    throw new GateError("REFUSED_MATERIAL_SET");
  }

  const materials = readJson(ctx, ctx.opts.materials, "materials", "REFUSED_MATERIAL_SET");
  verifyInputPin(ctx, "materials", "materials-sha256", "REFUSED_MATERIAL_SET");
  checkKeys(materials, ["schema", "ticket", "items"], [], "REFUSED_MATERIAL_SET");
  if (materials.schema !== "shiguang-music-engine-license-materials/v1") throw new GateError("REFUSED_MATERIAL_SET");
  if (materials.ticket !== ctx.opts.ticket) throw new GateError("REFUSED_MATERIAL_SET");
  const materialIds = materialIdSet(materials.items, "REFUSED_MATERIAL_SET");
  if (!equalIdSets(materialIds, REQUIRED_MATERIAL_IDS)) throw new GateError("REFUSED_MATERIAL_SET");

  if (!Array.isArray(approval.allowedEvidence) || approval.allowedEvidence.length < 1) {
    throw new GateError("REFUSED_MATERIAL_EVIDENCE");
  }
  if (approval.allowedEvidence.length > LIMITS.evidenceFiles) throw new GateError("REFUSED_MATERIAL_EVIDENCE");
  const allowed = new Map();
  for (const evidence of approval.allowedEvidence) {
    checkKeys(evidence, ["id", "path", "sha256", "locator"], [], "REFUSED_MATERIAL_EVIDENCE");
    if (typeof evidence.id !== "string" || evidence.id.length === 0 || allowed.has(evidence.id)) {
      throw new GateError("REFUSED_MATERIAL_EVIDENCE");
    }
    if (typeof evidence.path !== "string" || !path.isAbsolute(evidence.path)) {
      throw new GateError("REFUSED_MATERIAL_EVIDENCE");
    }
    if (typeof evidence.sha256 !== "string" || !SHA256_RE.test(evidence.sha256)) {
      throw new GateError("REFUSED_MATERIAL_EVIDENCE");
    }
    if (typeof evidence.locator !== "string" || evidence.locator.length === 0) {
      throw new GateError("REFUSED_MATERIAL_EVIDENCE");
    }
    allowed.set(evidence.id, evidence);
  }

  const collabRoot = path.join(ctx.opts.cwd, "collab");
  const evidenceBytes = new Map();
  let present = 0;
  for (const item of materials.items) {
    if (item.status === "MATCH") {
      const evidence = allowed.get(item.evidenceRef);
      if (!evidence) throw new GateError("REFUSED_MATERIAL_EVIDENCE");
      const normalized = path.resolve(evidence.path);
      if (normalized !== collabRoot && !normalized.startsWith(`${collabRoot}${path.sep}`)) {
        throw new GateError("REFUSED_MATERIAL_EVIDENCE");
      }
      if (!evidenceBytes.has(evidence.id)) {
        let data;
        try {
          data = readBounded(ctx, evidence.path, {
            singleMax: LIMITS.evidenceFile,
            totalMax: LIMITS.evidenceTotal,
            totalUsed: ctx.evidenceBytesUsed,
            counterKey: "evidenceBytes",
          });
        } catch (error) {
          if (error instanceof BudgetError || error instanceof DeadlineError) throw error;
          throw new GateError("REFUSED_MATERIAL_EVIDENCE");
        }
        if (sha256(data) !== evidence.sha256) throw new GateError("REFUSED_MATERIAL_EVIDENCE");
        evidenceBytes.set(evidence.id, data);
      }
      present += 1;
    }
  }
  if (present !== REQUIRED_MATERIAL_IDS.length) throw new GateError("REFUSED_LICENSE_MATERIALS");
  ctx.approval = approval;
  ctx.allowedEvidence = allowed;
  ctx.evidenceBytes = evidenceBytes;
  return { required: REQUIRED_MATERIAL_IDS.length, present, authority: "OUT_OF_BAND_PIN_ONLY" };
}

function gateG5(ctx) {
  const membersBytes = readBounded(ctx, ctx.opts.members, {
    singleMax: LIMITS.jsonSingle,
    totalMax: LIMITS.jsonTotal,
    totalUsed: ctx.jsonTotalUsed,
    counterKey: "jsonTotal",
  });
  ctx.inputBytes.members = membersBytes;
  verifyInputPin(ctx, "members", "members-sha256", "REFUSED_DECLARATION");
  const membersRaw = membersBytes.toString("utf8");
  const parsed = parseReleaseMembers(membersRaw);
  if (!parsed.ok) throw new GateError("REFUSED_DECLARATION");
  const expectation = readJson(ctx, ctx.opts.expectation, "expectation", "REFUSED_EXPECTATION");
  verifyInputPin(ctx, "expectation", "expectation-sha256", "REFUSED_EXPECTATION");
  checkKeys(
    expectation,
    ["schema", "ticket", "layout", "external", "projection", "toolchainCoverage"],
    [],
    "REFUSED_EXPECTATION",
  );
  if (expectation.schema !== "shiguang-music-engine-preflight-expectation/v1") {
    throw new GateError("REFUSED_EXPECTATION");
  }
  if (expectation.ticket !== ctx.opts.ticket) throw new GateError("REFUSED_EXPECTATION");
  if (expectation.layout !== ctx.opts.layout) throw new GateError("REFUSED_EXPECTATION");
  checkKeys(expectation.external, ["archiveSha256"], ["archiveBytes", "releaseVersion", "members"], "REFUSED_EXPECTATION");
  const external = ctx.io.safeCheckExpectation(parsed, expectation.external);
  if (!external) throw new GateError("REFUSED_EXPECTATION");

  ctx.parsedMembers = parsed;
  ctx.expectation = expectation;
  try {
    ctx.execution = executionEligibility(parsed);
  } catch {
    ctx.execution = { approved: false, code: "UNKNOWN_EXECUTION_ELIGIBILITY", memberCount: 0 };
  }
  return { declaration: "PARSED", externalPin: "MATCHED" };
}

function gateG6(ctx) {
  const projection = ctx.expectation.projection;
  checkKeys(
    projection,
    ["entries", "bytes", "symlinks", "maxFileBytes", "archiveBytes", "provenance"],
    [],
    "UNKNOWN_SIZE",
  );
  for (const key of ["entries", "bytes", "symlinks", "maxFileBytes", "archiveBytes"]) {
    if (!Number.isSafeInteger(projection[key]) || projection[key] < 0) throw new GateError("UNKNOWN_SIZE");
  }
  if (typeof projection.provenance !== "string" || projection.provenance.length === 0) {
    throw new GateError("UNKNOWN_SIZE");
  }
  const layout = ctx.opts.layout;
  const numericCompatible =
    projection.archiveBytes <= 130 * MiB &&
    projection.bytes <= 256 * MiB &&
    projection.maxFileBytes <= 256 * MiB &&
    projection.entries <= 8 &&
    projection.symlinks === 0;
  ctx.install = { status: "NOT_EVALUATED", code: null };
  if (layout === "legacy-onefile") {
    if (projection.entries !== 1) throw new GateError("REFUSED_CONTRACT_STATIC");
    if (!numericCompatible) throw new GateError("REFUSED_CONTRACT_STATIC");
    ctx.install = { status: "UNKNOWN", code: "UNKNOWN_RUNTIME_NOT_MODELED", numeric: "COMPATIBLE" };
  } else if (layout === "onedir") {
    if (!numericCompatible) {
      ctx.install = { status: "REFUSED", code: "REFUSED_STATIC_PROJECTION" };
      throw new GateError("REFUSED_CONTRACT_STATIC");
    }
    ctx.install = { status: "NUMERIC_COMPATIBLE", code: null, numeric: "COMPATIBLE" };
  } else {
    if (!numericCompatible || projection.entries < 2) {
      ctx.install = { status: "REFUSED", code: "REFUSED_STATIC_PROJECTION" };
      throw new GateError("REFUSED_CONTRACT_STATIC");
    }
    ctx.install = { status: "REFUSED", code: "REFUSED_STATIC_PROJECTION", reason: "MULTI_MEMBER_INSTALL_NOT_OPEN" };
    throw new GateError("REFUSED_CONTRACT_STATIC");
  }
  return { layout, numeric: "COMPATIBLE" };
}

function gateG3(ctx) {
  const coverage = ctx.expectation.toolchainCoverage;
  checkKeys(coverage, ["declaredComplete", "categories", "manifestRef"], [], "UNKNOWN_TOOLCHAIN_COVERAGE");
  checkKeys(coverage.categories, ["interpreter", "hooksCode", "dependencyClosure"], [], "UNKNOWN_TOOLCHAIN_COVERAGE");
  const complete =
    coverage.declaredComplete === true &&
    coverage.categories.interpreter === true &&
    coverage.categories.hooksCode === true &&
    coverage.categories.dependencyClosure === true;
  if (!complete) throw new GateError("UNKNOWN_TOOLCHAIN_COVERAGE");
  if (typeof coverage.manifestRef !== "string") throw new GateError("UNKNOWN_TOOLCHAIN_COVERAGE");
  const evidence = ctx.allowedEvidence.get(coverage.manifestRef);
  if (!evidence) throw new GateError("UNKNOWN_TOOLCHAIN_COVERAGE");
  const collabRoot = path.join(ctx.opts.cwd, "collab");
  const normalized = path.resolve(evidence.path);
  if (normalized !== collabRoot && !normalized.startsWith(`${collabRoot}${path.sep}`)) {
    throw new GateError("UNKNOWN_TOOLCHAIN_COVERAGE");
  }
  const data = readBounded(ctx, evidence.path, {
    singleMax: LIMITS.evidenceFile,
    totalMax: LIMITS.evidenceTotal,
    totalUsed: ctx.evidenceBytesUsed,
    counterKey: "evidenceBytes",
  });
  if (sha256(data) !== evidence.sha256) throw new GateError("UNKNOWN_TOOLCHAIN_COVERAGE");
  let manifest;
  try {
    manifest = JSON.parse(data.toString("utf8"));
  } catch {
    throw new GateError("UNKNOWN_TOOLCHAIN_COVERAGE");
  }
  if (!isRecord(manifest) || manifest.schema !== "shiguang-music-engine-toolchain-manifest/v1") {
    throw new GateError("UNKNOWN_TOOLCHAIN_COVERAGE");
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length < 1) {
    throw new GateError("UNKNOWN_TOOLCHAIN_COVERAGE");
  }
  const byId = new Map(ctx.pins.map((pin) => [pin.id, pin]));
  for (const entry of manifest.entries) {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.sha256 !== "string") {
      throw new GateError("UNKNOWN_TOOLCHAIN_COVERAGE");
    }
    const pin = byId.get(entry.id);
    if (!pin || pin.sha256 !== entry.sha256) throw new GateError("UNKNOWN_TOOLCHAIN_COVERAGE");
  }
  return { coverage: "DECLARED_COMPLETE", exhaustiveness: "NOT_PROVEN" };
}

function buildEvaluation(firstFailure, checkedGate) {
  const gates = GATE_ORDER.map((id) => ({ id, status: "NOT_EVALUATED", code: null }));
  const checkedPrefix = [];
  if (firstFailure === null) {
    for (const gate of gates) gate.status = "PASS";
    return {
      verdict: "PASS",
      firstFailure: null,
      checkedPrefix: [...GATE_ORDER],
      notEvaluated: [],
      gates,
    };
  }
  const index = GATE_ORDER.indexOf(checkedGate);
  for (let i = 0; i <= index; i += 1) {
    checkedPrefix.push(GATE_ORDER[i]);
    gates[i].status = i === index ? (firstFailure.startsWith("REFUSED_") ? "REFUSED" : "UNKNOWN") : "PASS";
    if (i === index) gates[i].code = firstFailure;
  }
  return {
    verdict: firstFailure.startsWith("REFUSED_") ? "REFUSED" : "UNKNOWN",
    firstFailure,
    checkedPrefix,
    notEvaluated: GATE_ORDER.slice(index + 1),
    gates,
  };
}

function eligibilityBlock(ctx, evaluation) {
  const evaluatedG5 = evaluation.checkedPrefix.includes("G5") && !evaluation.notEvaluated.includes("G5");
  const evaluatedG6 = evaluation.checkedPrefix.includes("G6") && !evaluation.notEvaluated.includes("G6");
  let execution = { status: "NOT_EVALUATED", code: null };
  if (evaluatedG5 && ctx.execution) {
    if (ctx.execution.approved === true) execution = { status: "APPROVED", code: null };
    else execution = { status: "REFUSED", code: ctx.execution.code };
  }
  let install = { status: "NOT_EVALUATED", code: null };
  if (evaluatedG6 && ctx.install) install = { ...ctx.install };
  return {
    build: { status: "REFUSED", code: "REFUSED_NOT_GRANTED", basis: "preflight-only ticket; no build subcommand or token" },
    install,
    execution,
  };
}

function buildReport(ctx, evaluation, finalExit) {
  return {
    schema: "shiguang-music-engine-preflight-report/v3",
    ticket: ctx.opts.ticket,
    inputs: {
      pinsSha256: ctx.opts["pins-sha256"],
      approvalSha256: ctx.opts["approval-sha256"],
      materialsSha256: ctx.opts["materials-sha256"],
      expectationSha256: ctx.opts["expectation-sha256"],
      membersSha256: ctx.opts["members-sha256"],
    },
    evaluation,
    finalization: {
      status: "COMPLETE",
      code: null,
      stage: null,
      reportUsable: true,
      sumsWritten: true,
      lateOwnedFds: 0,
      unsettledOperations: 0,
    },
    finalExit,
    eligibility: eligibilityBlock(ctx, evaluation),
    authority: { kind: "OUT_OF_BAND_PIN_ONLY", authenticated: false, mayAuthorizeBuild: false },
    redaction: { absolutePaths: false, credentials: false },
  };
}

function renderMarkdown(report) {
  const gates = report.evaluation.gates
    .map((gate) => `| ${gate.id} | ${gate.status} | ${gate.code ?? "-"} |`)
    .join("\n");
  const lines = [
    "# Music engine preflight report",
    "",
    `- ticket: \`${report.ticket}\``,
    `- verdict: \`${report.evaluation.verdict}\``,
    `- firstFailure: \`${report.evaluation.firstFailure ?? "null"}\``,
    `- finalExit: \`${report.finalExit}\``,
    `- checkedPrefix: \`${report.evaluation.checkedPrefix.join(",")}\``,
    `- notEvaluated: \`${report.evaluation.notEvaluated.join(",") || "-"}\``,
    "",
    "## Gates",
    "",
    "| gate | status | code |",
    "|---|---|---|",
    gates,
    "",
    "## Eligibility (reported, never authorization)",
    "",
    `- build: \`${report.eligibility.build.status}\` / \`${report.eligibility.build.code ?? "-"}\``,
    `- install: \`${report.eligibility.install.status}\` / \`${report.eligibility.install.code ?? "-"}\``,
    `- execution: \`${report.eligibility.execution.status}\` / \`${report.eligibility.execution.code ?? "-"}\``,
    "",
    "## Boundary",
    "",
    "- preflight PASS would only mean the synthetic/evidence gates passed; it is not a build, install or execution grant.",
    "- authority hash binds bytes only; issuer is not authenticated.",
    "- No absolute path, credential or exception message is recorded.",
    "",
  ];
  return lines.join("\n");
}

function renderNotRun(ctx, evaluation) {
  const notEvaluated = evaluation.notEvaluated.length > 0 ? evaluation.notEvaluated.join(", ") : "none";
  return [
    "# NOT_RUN",
    "",
    `- ticket: \`${ctx.opts.ticket}\``,
    `- not evaluated gates: \`${notEvaluated}\``,
    "- real build / PyInstaller / Python import / hooks / model ffi: NOT RUN",
    "- real engine execution / probe / --help: NOT RUN",
    "- real plugin venv or real media scan: NOT RUN",
    "- install / deploy / submit / push / network: NOT RUN",
    "- cloud account / database / Docker / formal service: NOT RUN",
    "- synthesis tests are not a real toolchain, model or media proof.",
    "",
  ].join("\n");
}

// R3: each actual write is one pre-registered operation against the single
// fixed fEnd. The clock is observed after the real syscall returns, so a short
// write that crosses the deadline can never be followed by another write; the
// buffer is not filled further and no window is re-granted. Short-write
// handling itself (loop until offset === buffer.length) is preserved.
function writeAll(ctx, fd, buffer, stage, code = "UNKNOWN_EVIDENCE") {
  let offset = 0;
  while (offset < buffer.length) {
    const writeOp = beginF(ctx, "WRITE", stage, code);
    let written;
    try {
      written = ctx.io.writeSync(fd, buffer, offset, buffer.length - offset, offset);
    } catch {
      ctx.ledger.fail(writeOp);
      throw new FinalizeError(stage, code);
    }
    ctx.ledger.settle(writeOp);
    if (written <= 0) throw new FinalizeError(stage, code);
    offset += written;
    afterF(ctx, stage, code);
  }
}

function writeOutput(ctx, directory, baseName, buffer, maxBytes, stage) {
  if (buffer.length > maxBytes) throw new FinalizeError(stage, "UNKNOWN_EVIDENCE");
  const tmpPath = path.join(directory, `${baseName}.tmp`);
  const openOp = beginF(ctx, "OPEN", stage);
  let fd;
  try {
    fd = ctx.io.openSync(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  } catch {
    ctx.ledger.fail(openOp);
    throw new FinalizeError(stage, "UNKNOWN_EVIDENCE");
  }
  ctx.ledger.settle(openOp);
  ctx.ledger.own(openOp, fd);
  try {
    afterF(ctx, stage, "UNKNOWN_EVIDENCE");
    writeAll(ctx, fd, buffer, stage, "UNKNOWN_EVIDENCE");

    const fsyncOp = beginF(ctx, "FSYNC", "FSYNC");
    try {
      ctx.io.fsyncSync(fd);
    } catch {
      ctx.ledger.fail(fsyncOp);
      throw new FinalizeError("FSYNC", "UNKNOWN_EVIDENCE");
    }
    ctx.ledger.settle(fsyncOp);
    afterF(ctx, "FSYNC");
    closeOwned(ctx, fd, openOp, "CLOSE", "UNKNOWN_IO");
  } catch (error) {
    if (ctx.ledger.isOwned(fd)) {
      try {
        closeOwned(ctx, fd, openOp, "CLOSE", "UNKNOWN_IO");
      } catch {
        /* ownership failure already recorded; no retry */
      }
    }
    if (error instanceof FinalizeError) throw error;
    throw new FinalizeError(stage, "UNKNOWN_EVIDENCE");
  }
  return tmpPath;
}

function renameOutput(ctx, from, to) {
  const op = beginF(ctx, "RENAME", "RENAME");
  try {
    ctx.io.renameSync(from, to);
  } catch {
    ctx.ledger.fail(op);
    throw new FinalizeError("RENAME", "UNKNOWN_EVIDENCE");
  }
  ctx.ledger.settle(op);
  afterF(ctx, "RENAME");
}

const SUMS_NAMES = Object.freeze(["preflight-report.json", "preflight-report.md", "NOT_RUN.md"]);
const SUMS_LINE_RE = /^([0-9a-f]{64})  (preflight-report\.json|preflight-report\.md|NOT_RUN\.md)$/;

// P2-3: every finalization-region read is registered before it is issued and is
// bounded by the single fixed fEnd; no unbounded directory scan or retry window.
function readFinalFile(ctx, filePath, maxBytes, stage) {
  const lstatOp = beginF(ctx, "LSTAT", stage, "UNKNOWN_EVIDENCE");
  let before;
  try {
    before = ctx.io.lstatSync(filePath);
  } catch {
    ctx.ledger.fail(lstatOp);
    throw new FinalizeError(stage, "UNKNOWN_EVIDENCE");
  }
  ctx.ledger.settle(lstatOp);
  if (!before.isFile() || before.isSymbolicLink()) throw new FinalizeError(stage, "UNKNOWN_EVIDENCE");
  if (before.size <= 0 || before.size > maxBytes) throw new FinalizeError(stage, "UNKNOWN_EVIDENCE");
  afterF(ctx, stage, "UNKNOWN_EVIDENCE");

  const openOp = beginF(ctx, "OPEN", stage, "UNKNOWN_EVIDENCE");
  let fd;
  try {
    fd = ctx.io.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    ctx.ledger.fail(openOp);
    throw new FinalizeError(stage, "UNKNOWN_EVIDENCE");
  }
  ctx.ledger.settle(openOp);
  ctx.ledger.own(openOp, fd);
  try {
    afterF(ctx, stage, "UNKNOWN_EVIDENCE");
    let fstat;
    const fstatOp = beginF(ctx, "FSTAT", stage, "UNKNOWN_EVIDENCE");
    try {
      fstat = ctx.io.fstatSync(fd);
    } catch {
      ctx.ledger.fail(fstatOp);
      throw new FinalizeError(stage, "UNKNOWN_EVIDENCE");
    }
    ctx.ledger.settle(fstatOp);
    afterF(ctx, stage, "UNKNOWN_EVIDENCE");
    if (fstat.dev !== before.dev || fstat.ino !== before.ino || fstat.size !== before.size) {
      throw new FinalizeError(stage, "UNKNOWN_EVIDENCE");
    }
    const chunks = [];
    let offset = 0;
    while (offset < before.size) {
      const length = Math.min(LIMITS.block, before.size - offset);
      const buffer = Buffer.allocUnsafe(length);
      const readOp = beginF(ctx, "READ", stage, "UNKNOWN_EVIDENCE");
      let read;
      try {
        read = ctx.io.readSync(fd, buffer, 0, length, offset);
      } catch {
        ctx.ledger.fail(readOp);
        throw new FinalizeError(stage, "UNKNOWN_EVIDENCE");
      }
      ctx.ledger.settle(readOp);
      if (read <= 0) throw new FinalizeError(stage, "UNKNOWN_EVIDENCE");
      chunks.push(buffer.subarray(0, read));
      offset += read;
      afterF(ctx, stage, "UNKNOWN_EVIDENCE");
    }
    const afterOp = beginF(ctx, "LSTAT", stage, "UNKNOWN_EVIDENCE");
    let after;
    try {
      after = ctx.io.lstatSync(filePath);
    } catch {
      ctx.ledger.fail(afterOp);
      throw new FinalizeError(stage, "UNKNOWN_EVIDENCE");
    }
    ctx.ledger.settle(afterOp);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size
    ) {
      throw new FinalizeError(stage, "UNKNOWN_EVIDENCE");
    }
    afterF(ctx, stage, "UNKNOWN_EVIDENCE");
    return Buffer.concat(chunks, offset);
  } finally {
    closeOwned(ctx, fd, openOp, stage, "UNKNOWN_IO");
  }
}

function parseSumsManifest(text) {
  // Strict exactly-three, distinct, fixed-name, lowercase-hex manifest. Any
  // other line (short file, duplicate name, absolute path, extra text) is a
  // corrupted manifest, never a partial success.
  if (!text.endsWith("\n")) return null;
  const lines = text.slice(0, -1).split("\n");
  if (lines.length !== SUMS_NAMES.length) return null;
  const map = new Map();
  for (const line of lines) {
    const match = SUMS_LINE_RE.exec(line);
    if (!match) return null;
    const name = match[2];
    if (map.has(name)) return null;
    map.set(name, match[1]);
  }
  for (const name of SUMS_NAMES) if (!map.has(name)) return null;
  return map;
}

function selfCheck(ctx, directory, expected) {
  // P2-2: read and parse the actual on-disk SHA256SUMS inside the same fEnd,
  // then verify each actual file hash against both that manifest and the
  // intended content. A manifest mutated after write must fail finalization.
  const sumsBuffer = readFinalFile(ctx, path.join(directory, "SHA256SUMS"), LIMITS.sumsBytes, "SELF_CHECK");
  const manifest = parseSumsManifest(sumsBuffer.toString("utf8"));
  if (!manifest) throw new FinalizeError("SELF_CHECK", "UNKNOWN_EVIDENCE");
  const expectedMap = new Map(expected);
  if (expectedMap.size !== SUMS_NAMES.length) throw new FinalizeError("SELF_CHECK", "UNKNOWN_EVIDENCE");
  for (const [name] of expectedMap) {
    if (!manifest.has(name)) throw new FinalizeError("SELF_CHECK", "UNKNOWN_EVIDENCE");
  }
  for (const [name, hash] of expectedMap) {
    const checkOp = beginF(ctx, "SELF_CHECK", "SELF_CHECK");
    try {
      const data = readFinalFile(ctx, path.join(directory, name), LIMITS.reportBytes, "SELF_CHECK");
      const actual = sha256(data);
      if (actual !== hash) throw new FinalizeError("SELF_CHECK", "UNKNOWN_EVIDENCE");
      if (manifest.get(name) !== actual) throw new FinalizeError("SELF_CHECK", "UNKNOWN_EVIDENCE");
    } catch (error) {
      if (checkOp.state === "PENDING") ctx.ledger.fail(checkOp);
      throw error;
    }
    ctx.ledger.settle(checkOp);
    afterF(ctx, "SELF_CHECK");
  }
}

function writeIncomplete(ctx, evaluation, finalization) {
  // P2-3: at most one diagnostic attempt, only while the fixed fEnd is live;
  // every open/write/fsync/close is pre-registered and deadline-bounded.
  if (ctx.now() >= ctx.fEnd) return;
  const payload = {
    schema: "shiguang-music-engine-preflight-incomplete/v1",
    finalExit: 12,
    evaluation: {
      firstFailure: evaluation.firstFailure,
      checkedPrefix: evaluation.checkedPrefix,
    },
    finalization: {
      status: "FAILED",
      code: finalization.code,
      stage: finalization.stage,
      reportUsable: false,
      sumsWritten: false,
      lateOwnedFds: finalization.lateOwnedFds,
      unsettledOperations: finalization.unsettledOperations,
    },
  };
  const buffer = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
  if (buffer.length > LIMITS.incompleteBytes) return;
  let fd;
  let openOp;
  try {
    openOp = beginF(ctx, "OPEN", "INCOMPLETE", "UNKNOWN_EVIDENCE");
    fd = ctx.io.openSync(
      path.join(ctx.opts.out, "INCOMPLETE.json"),
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
  } catch {
    if (openOp && openOp.state === "PENDING") ctx.ledger.fail(openOp);
    return;
  }
  ctx.ledger.settle(openOp);
  ctx.ledger.own(openOp, fd);
  try {
    afterF(ctx, "INCOMPLETE", "UNKNOWN_EVIDENCE");
    writeAll(ctx, fd, buffer, "INCOMPLETE", "UNKNOWN_EVIDENCE");
    const fsyncOp = beginF(ctx, "FSYNC", "INCOMPLETE", "UNKNOWN_EVIDENCE");
    try {
      ctx.io.fsyncSync(fd);
    } catch {
      ctx.ledger.fail(fsyncOp);
      throw new FinalizeError("INCOMPLETE", "UNKNOWN_EVIDENCE");
    }
    ctx.ledger.settle(fsyncOp);
    afterF(ctx, "INCOMPLETE", "UNKNOWN_EVIDENCE");
  } catch {
    /* exactly one attempt; any partial file is retained as-is */
  } finally {
    try {
      closeOwned(ctx, fd, openOp, "INCOMPLETE", "UNKNOWN_IO");
    } catch {
      /* ownership failure retained in the ledger, never retried */
    }
  }
}

function finalize(ctx, evaluation, reportBase) {
  const finalization = {
    status: "COMPLETE",
    code: null,
    stage: null,
    reportUsable: true,
    sumsWritten: true,
    lateOwnedFds: 0,
    unsettledOperations: 0,
  };
  let outCreated = false;
  ctx.inFinalize = true;
  try {
    if (ctx.now() >= ctx.fEnd) throw new FinalizeError("RESERVE", "UNKNOWN_EVIDENCE");
    if (!ctx.outValidated) throw new FinalizeError("RESERVE", "UNKNOWN_EVIDENCE");
    const reserveOp = ctx.ledger.begin("RESERVE");
    try {
      ctx.io.mkdirSync(ctx.opts.out, { mode: 0o700 });
    } catch {
      ctx.ledger.fail(reserveOp);
      throw new FinalizeError("RESERVE", "UNKNOWN_EVIDENCE");
    }
    ctx.ledger.settle(reserveOp);
    outCreated = true;
    afterF(ctx, "RESERVE");

    const pending = ctx.ledger.pending();
    if (pending.length > 0) {
      finalization.unsettledOperations = pending.length;
      throw new FinalizeError("SETTLE", "UNKNOWN_IO");
    }

    if (ctx.closeFailed > 0) throw new FinalizeError("CLOSE", "UNKNOWN_IO");

    const report = reportBase;
    const reportJson = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
    const reportMd = Buffer.from(renderMarkdown(report), "utf8");
    const notRun = Buffer.from(renderNotRun(ctx, evaluation), "utf8");
    if (reportJson.length > LIMITS.reportBytes) throw new FinalizeError("WRITE", "UNKNOWN_EVIDENCE");

    const jsonTmp = writeOutput(ctx, ctx.opts.out, "preflight-report.json", reportJson, LIMITS.reportBytes, "WRITE");
    const mdTmp = writeOutput(ctx, ctx.opts.out, "preflight-report.md", reportMd, LIMITS.reportBytes, "WRITE");
    const notRunTmp = writeOutput(ctx, ctx.opts.out, "NOT_RUN.md", notRun, LIMITS.reportBytes, "WRITE");

    renameOutput(ctx, jsonTmp, path.join(ctx.opts.out, "preflight-report.json"));
    renameOutput(ctx, mdTmp, path.join(ctx.opts.out, "preflight-report.md"));
    renameOutput(ctx, notRunTmp, path.join(ctx.opts.out, "NOT_RUN.md"));

    const sums = [
      `${sha256(reportJson)}  preflight-report.json`,
      `${sha256(reportMd)}  preflight-report.md`,
      `${sha256(notRun)}  NOT_RUN.md`,
    ].join("\n") + "\n";
    const sumsBuffer = Buffer.from(sums, "utf8");
    if (sumsBuffer.length > LIMITS.sumsBytes) throw new FinalizeError("SUMS", "UNKNOWN_EVIDENCE");
    const sumsTmp = writeOutput(ctx, ctx.opts.out, "SHA256SUMS", sumsBuffer, LIMITS.sumsBytes, "SUMS");
    renameOutput(ctx, sumsTmp, path.join(ctx.opts.out, "SHA256SUMS"));

    selfCheck(ctx, ctx.opts.out, [
      ["preflight-report.json", sha256(reportJson)],
      ["preflight-report.md", sha256(reportMd)],
      ["NOT_RUN.md", sha256(notRun)],
    ]);

    finalization.lateOwnedFds = ctx.ledger.lateOwnedFds;
    finalization.unsettledOperations = 0;
  } catch (error) {
    finalization.status = "FAILED";
    if (error instanceof FinalizeError) {
      finalization.stage = error.stage;
      finalization.code = error.code;
    } else {
      finalization.stage = "WRITE";
      finalization.code = "UNKNOWN_EVIDENCE";
    }
    finalization.reportUsable = false;
    finalization.sumsWritten = false;
    finalization.lateOwnedFds = ctx.ledger.lateOwnedFds;
    finalization.unsettledOperations = ctx.ledger.pending().length;
    if (outCreated) writeIncomplete(ctx, evaluation, finalization);
  }
  return finalization;
}

function emitUsage(code) {
  return {
    exitCode: 2,
    stdout: `${JSON.stringify({
      schema: "shiguang-music-engine-preflight-cli/v1",
      finalExit: 2,
      firstFailure: code,
      checkedPrefix: ["G0"],
    })}\n`,
    stderr: "",
  };
}

export function runPreflight(options = {}) {
  const argv = options.argv ?? [];
  const cwd = options.cwd ?? process.cwd();
  const io = { ...BASE_IO, ...(options.io ?? {}) };
  io.safeCheckExpectation = (parsed, external) => {
    try {
      return checkExternalExpectation(parsed, external).ok;
    } catch {
      return false;
    }
  };
  const now = options.now ?? (() => globalThis.performance.now());
  const ledger = createLedger(now);
  let opts;
  try {
    opts = parseCli(argv);
  } catch (error) {
    return emitUsage(error instanceof UsageError ? error.code : "REFUSED_USAGE");
  }
  opts.cwd = cwd;
  const ctx = {
    opts,
    io,
    now,
    ledger,
    outValidated: false,
    jsonTotalUsed: 0,
    pinBytesUsed: 0,
    evidenceBytesUsed: 0,
    inputBytes: {},
    closeFailed: 0,
    hooks: options.hooks ?? {},
    t0: now(),
  };
  ctx.checkEval = () => evalCheck(ctx);
  ctx.dEval = ctx.t0 + LIMITS.evalMs;
  ctx.dTotal = ctx.t0 + LIMITS.totalMs;

  let g0Refused = false;
  try {
    checkG0Path(ctx);
  } catch (error) {
    if (error instanceof DeadlineError) {
      const evaluation = buildEvaluation("UNKNOWN_READ_DEADLINE", "G0");
      ctx.fStart = now();
      ctx.fEnd = Math.min(ctx.fStart + LIMITS.finalMs, ctx.dTotal);
      const expected = ctx.outValidated ? 11 : 12;
      const finalization = finalize(ctx, evaluation, buildReport(ctx, evaluation, expected));
      const exitCode = computeFinalExit(false, evaluation, finalization);
      return { exitCode, stdout: "", stderr: "" };
    }
    g0Refused = true;
    const code = error instanceof PathError ? "REFUSED_PATH" : "REFUSED_USAGE";
    return emitUsage(code);
  }

  let firstFailure = null;
  let checkedGate = null;
  try {
    ctx.currentGate = "G1";
    ctx.g1 = gateG1(ctx);
    ctx.currentGate = "G2";
    ctx.g2 = gateG2(ctx);
    ctx.currentGate = "G4";
    gateG4(ctx);
    ctx.currentGate = "G5";
    gateG5(ctx);
    ctx.currentGate = "G6";
    gateG6(ctx);
    ctx.currentGate = "G3";
    gateG3(ctx);
  } catch (error) {
    if (error instanceof DeadlineError) {
      firstFailure = "UNKNOWN_READ_DEADLINE";
    } else if (error instanceof BudgetError) {
      firstFailure = "UNKNOWN_READ_BUDGET";
    } else if (error instanceof SourceIoError) {
      firstFailure = "UNKNOWN_SOURCE_IO";
    } else if (error instanceof GateError) {
      firstFailure = error.code;
    } else {
      firstFailure = "UNKNOWN_SOURCE_IO";
    }
    checkedGate = ctx.currentGate ?? "G0";
    if (checkedGate === "G0" && firstFailure !== "UNKNOWN_READ_DEADLINE") {
      return emitUsage("REFUSED_USAGE");
    }
  }

  ctx.fStart = now();
  ctx.fEnd = Math.min(ctx.fStart + LIMITS.finalMs, ctx.dTotal);
  const evaluation = buildEvaluation(firstFailure, checkedGate);
  const provisional = buildReport(ctx, evaluation, 0);
  const finalExitPreview = computeFinalExit(false, evaluation, provisional.finalization);
  const report = buildReport(ctx, evaluation, finalExitPreview);
  const finalization = finalize(ctx, evaluation, report);
  const finalExit = computeFinalExit(g0Refused, evaluation, finalization);
  const byKind = {};
  const byState = {};
  for (const op of ctx.ledger.ops) {
    byKind[op.kind] = (byKind[op.kind] ?? 0) + 1;
    byState[op.state] = (byState[op.state] ?? 0) + 1;
  }
  const ledgerSummary = {
    operations: ctx.ledger.ops.length,
    byKind,
    byState,
    pending: ctx.ledger.pending().length,
    ownedOpen: ctx.ledger.openCount(),
    lateOwnedFds: ctx.ledger.lateOwnedFds,
    closeFailed: ctx.closeFailed,
  };
  return { exitCode: finalExit, stdout: "", stderr: "", ledgerSummary };
}

async function main() {
  const result = runPreflight({ argv: process.argv.slice(2), cwd: process.cwd() });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
