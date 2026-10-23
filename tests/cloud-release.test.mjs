/**
 * T-LOCAL-009：正式发行连接配置的定向验收。
 *
 * 只读项目内 config/cloud-release.json 与临时 MEDIA_DATA_DIR；不连接生产业务、
 * 不兑换开通码、不生成设备身份、不写真实库/素材。公开根 CA 不是设备证书。
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Library } from "../server/library.mjs";
import { CloudAuth } from "../server/cloud-auth.mjs";
import { DeviceEnrollment } from "../server/device-enrollment.mjs";
import { loadReleaseConfig } from "../server/cloud-release-config.mjs";

const project = fileURLToPath(new URL("../", import.meta.url));
const configPath = path.join(project, "config/cloud-release.json");
const PRODUCTION_CA_SHA256 = "66:5A:D3:0D:94:FE:BF:20:49:E0:65:31:91:A7:95:F2:87:DE:96:70:9A:3D:AB:4D:00:80:DC:55:53:BA:CF:46";

test("正式发行配置：启用、两个公开 origin、同一公开根 CA、无私钥", async () => {
  const config = await loadReleaseConfig(configPath);
  assert.deepEqual(config.errors, []);
  assert.deepEqual(config.warnings, []);
  assert.equal(config.enabled, true);
  assert.equal(config.usable, true);
  assert.equal(config.apiOrigin, "https://112.74.109.173:8443");
  assert.equal(config.enrollmentOrigin, "https://112.74.109.173:8444");

  const serverCa = new crypto.X509Certificate(config.serverCaPem);
  const deviceCa = new crypto.X509Certificate(config.deviceCaPem);
  assert.equal(serverCa.ca, true);
  assert.equal(deviceCa.ca, true);
  assert.equal(serverCa.fingerprint256, PRODUCTION_CA_SHA256);
  assert.equal(deviceCa.fingerprint256, PRODUCTION_CA_SHA256);
  assert.equal(serverCa.raw.equals(deviceCa.raw), true, "两个 CA 字段必须使用同一公开根证书");

  const text = await fs.readFile(configPath, "utf8");
  assert.doesNotMatch(text, /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/);
  assert.doesNotMatch(text, /\.runtime|owner-device|offline\//, "发行配置不得引用私有运行材料");
});

test("无设备身份：配置就绪但状态为未登录，不伪装已开通", async (t) => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-release-")));
  const lib = await new Library(path.join(base, "data")).init();
  t.after(async () => {
    lib.db.close();
    await fs.rm(base, { recursive: true, force: true });
  });
  const config = await loadReleaseConfig(configPath);
  assert.equal(config.usable, true);

  const auth = await new CloudAuth(lib, { dataDir: lib.dataDir }).init();
  const enrollment = await new DeviceEnrollment(lib, {
    dataDir: lib.dataDir,
    cloudAuth: auth,
    release: config,
  }).init();

  const status = enrollment.getStatus();
  assert.equal(status.ready, true);
  assert.equal(status.enabled, true);
  assert.equal(status.configured, false);
  assert.equal(status.activated, false);
  assert.equal(status.deviceId, null);
  assert.equal(status.username, null);
  assert.equal(status.message, null);
  const authState = auth.getState();
  assert.equal(authState.state, "unconfigured");
  assert.equal(authState.needsLogin, false);
  assert.equal(authState.configured, false);
  assert.equal(authState.hasClientCertificate, false);
  await assert.rejects(fs.stat(path.join(lib.dataDir, "cloud-device")), (e) => e.code === "ENOENT");
});
