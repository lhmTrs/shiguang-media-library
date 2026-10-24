import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";

const source = await fs.readFile(new URL("../src/cloud-auth.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const exports = {};
vm.runInNewContext(compiled, { exports, require: createRequire(import.meta.url) });
const { describeFailure, enrollmentRecovery } = exports;

for (const code of ["DEVICE_PENDING_IDENTITY_MISMATCH", "DEVICE_PENDING_INVALID"]) {
  test(`${code} never redirects to advanced cloud configuration or echoes raw details`, () => {
    const text = describeFailure({ code, kind: "config", message: "secret-test-value" }, "login");
    assert.doesNotMatch(text, /高级云端设置|secret-test-value/);
    assert.match(text, /管理员/);
  });
}

test("pending activation stays in enrollment and gives the original identity retry path", () => {
  const result = enrollmentRecovery({ activationPending: true, error: { code: "INVALID_REQUEST" } });
  assert.equal(result.mode, "enroll");
  assert.match(result.message, /12 个字符/);
  assert.match(result.message, /72 个 UTF-8 字节/);
  assert.match(result.message, /原开通码和原设备名称/);
  assert.match(result.message, /旧码已撤销/);
});

test("activation network failure preserves the verified failure classification", () => {
  const result = enrollmentRecovery({ activationPending: true, error: { kind: "network", message: "secret-test-value" } });
  assert.equal(result.mode, "enroll");
  assert.match(result.message, /无法连接云端服务/);
  assert.doesNotMatch(result.message, /secret-test-value/);
});

test("activated device with failed login uses ordinary account login", () => {
  const result = enrollmentRecovery({ activationPending: false, error: { code: "UNAUTHORIZED" } });
  assert.equal(result.mode, "login");
  assert.match(result.message, /账户密码登录/);
  assert.doesNotMatch(result.message, /原开通码/);
});

test("ordinary config errors retain their existing settings guidance", () => {
  assert.match(describeFailure({ kind: "config" }, "login"), /高级云端设置/);
  assert.match(describeFailure({ code: "ENROLLMENT_PASSWORD_INVALID", kind: "config" }, "login"), /72 个 UTF-8 字节/);
});
