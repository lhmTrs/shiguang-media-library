/**
 * T-LOCAL-007：内置「发行版云端连接」配置。
 *
 * 只保存公共信息：两个 HTTPS origin 与两张公开 CA 证书（serverCaPem 验证云端
 * HTTPS，deviceCaPem 验证签发的设备证书）。绝不包含 PRIVATE KEY、口令、个人
 * 设备证书或运行时路径。
 *
 * 原始仓库默认 enabled=false、地址/证书为空；正式值由部署方在打包前用
 * scripts/cloud-release-config.mjs 生成，不能靠硬编码或从失败配置回退。
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";

export const RELEASE_CONFIG_SCHEMA = 1;
export const MAX_RELEASE_CONFIG_BYTES = 256 * 1024;
export const DEFAULT_RELEASE_CONFIG = Object.freeze({
  schemaVersion: RELEASE_CONFIG_SCHEMA,
  enabled: false,
  apiOrigin: "",
  enrollmentOrigin: "",
  serverCaPem: "",
  deviceCaPem: "",
});

const ORIGIN_KEYS = ["apiOrigin", "enrollmentOrigin"];

/** 只接受 https://host[:port]，禁止用户信息、路径、查询、hash */
export function parseOrigin(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 不能为空`);
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${label} 不是合法 URL`);
  }
  if (url.protocol !== "https:") throw new Error(`${label} 必须使用 https://`);
  if (url.username || url.password) throw new Error(`${label} 不能包含用户信息`);
  if (url.pathname !== "/" || url.search || url.hash)
    throw new Error(`${label} 只能包含协议、主机和端口，不能带路径、查询或 hash`);
  if (!url.hostname) throw new Error(`${label} 缺少主机名`);
  return `${url.protocol}//${url.host}`;
}

/** 从 PEM 文本里取全部 CERTIFICATE 块；任何 PRIVATE KEY 都直接拒绝 */
export function parsePublicCertificates(pem, label) {
  if (typeof pem !== "string" || !pem.trim()) throw new Error(`${label} 不能为空`);
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(pem)) throw new Error(`${label} 不能包含私钥`);
  const blocks = [...pem.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)].map((m) => m[0]);
  if (!blocks.length) throw new Error(`${label} 不是 PEM 证书`);
  let certificates;
  try {
    certificates = blocks.map((block) => new crypto.X509Certificate(block));
  } catch {
    throw new Error(`${label} 含无法解析的证书`);
  }
  return { pem: blocks.join("\n") + "\n", certificates };
}

function looksLikePrivateMaterial(value) {
  return typeof value === "string" && /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(value);
}

/**
 * 校验发行配置。返回 { config, errors, warnings, usable }，不抛异常，
 * 让启动路径在配置坏掉时安全地保持「未就绪」，而不是崩溃或回退到假地址。
 */
export function validateReleaseConfig(raw) {
  const errors = [];
  const warnings = [];
  const config = { ...DEFAULT_RELEASE_CONFIG };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { config, errors: ["发行配置必须是 JSON 对象"], warnings, usable: false };
  }
  if (raw.schemaVersion !== RELEASE_CONFIG_SCHEMA) errors.push(`schemaVersion 必须为 ${RELEASE_CONFIG_SCHEMA}`);
  config.schemaVersion = RELEASE_CONFIG_SCHEMA;
  if (typeof raw.enabled !== "boolean") errors.push("enabled 必须是布尔值");
  config.enabled = raw.enabled === true;

  for (const key of ["apiOrigin", "enrollmentOrigin", "serverCaPem", "deviceCaPem"]) {
    const value = raw[key];
    if (value !== undefined && typeof value !== "string") errors.push(`${key} 必须是字符串`);
    config[key] = typeof value === "string" ? value : "";
    if (looksLikePrivateMaterial(value)) errors.push(`${key} 不能包含私钥`);
  }
  const allowed = new Set(["schemaVersion", "enabled", ...ORIGIN_KEYS, "serverCaPem", "deviceCaPem"]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) warnings.push(`忽略未知字段 ${key}`);

  if (config.enabled) {
    for (const key of ORIGIN_KEYS) {
      try {
        config[key] = parseOrigin(config[key], key);
      } catch (e) {
        errors.push(e.message);
      }
    }
    for (const key of ["serverCaPem", "deviceCaPem"]) {
      try {
        config[key] = parsePublicCertificates(config[key], key).pem;
      } catch (e) {
        errors.push(e.message);
      }
    }
    if (errors.length === 0) {
      for (const [key, label] of [
        ["serverCaPem", "serverCaPem"],
        ["deviceCaPem", "deviceCaPem"],
      ]) {
        const certs = parsePublicCertificates(config[key], label).certificates;
        if (!certs.some((cert) => cert.ca === true)) errors.push(`${label} 必须包含 CA 证书`);
      }
    }
  } else {
    // 未启用时也要拒绝私钥，避免有人把私钥塞进打包文件。
    for (const key of ["serverCaPem", "deviceCaPem"]) {
      if (config[key]) {
        try {
          config[key] = parsePublicCertificates(config[key], key).pem;
        } catch (e) {
          errors.push(e.message);
        }
      }
    }
  }
  return { config, errors, warnings, usable: errors.length === 0 && config.enabled && Boolean(config.apiOrigin && config.enrollmentOrigin) };
}

/** 读取项目内的发行配置；文件不存在（原始仓库默认）按未启用处理，绝不创建文件。 */
export async function loadReleaseConfig(file) {
  let text;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return { ...DEFAULT_RELEASE_CONFIG, usable: false, errors: ["发行配置不是普通文件"], warnings: [] };
    if (stat.size > MAX_RELEASE_CONFIG_BYTES)
      return { ...DEFAULT_RELEASE_CONFIG, usable: false, errors: ["发行配置过大"], warnings: [] };
    text = await fs.readFile(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { ...DEFAULT_RELEASE_CONFIG, usable: false, errors: [], warnings: [], missing: true };
    return { ...DEFAULT_RELEASE_CONFIG, usable: false, errors: ["发行配置无法读取"], warnings: [] };
  }
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text))
    return { ...DEFAULT_RELEASE_CONFIG, usable: false, errors: ["发行配置不能包含私钥"], warnings: [] };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ...DEFAULT_RELEASE_CONFIG, usable: false, errors: ["发行配置不是合法 JSON"], warnings: [] };
  }
  const checked = validateReleaseConfig(raw);
  return { ...checked.config, usable: checked.usable, errors: checked.errors, warnings: checked.warnings };
}
