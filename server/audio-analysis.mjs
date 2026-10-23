/**
 * 本地音频分析：调用已安装的引擎二进制，结果写 asset_audio 表。
 *
 * - 不联网、不上传音频；只读文件 → spawn → 解析 JSON → 存库
 * - 串行队列（引擎吃 CPU），同一素材按 sha256 + 引擎版本缓存
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

const TIMEOUT_MS = 180_000;

export class AudioAnalysis {
  constructor(lib, engine) {
    this.lib = lib;
    this.engine = engine;
    this.chain = Promise.resolve();
    this.ready = null;
  }

  #table() {
    const idType = this.lib.mysql ? "VARCHAR(64)" : "TEXT";
    const num = this.lib.mysql ? "DOUBLE" : "REAL";
    return `CREATE TABLE IF NOT EXISTS asset_audio (
      asset_id ${idType} PRIMARY KEY,
      sha256 TEXT,
      bpm ${num},
      key_root TEXT,
      key_mode TEXT,
      loudness_rms ${num},
      loudness_peak ${num},
      energy_min ${num},
      energy_max ${num},
      duration ${num},
      structure_json TEXT,
      engine_version TEXT,
      analyzed_ms INTEGER,
      analyzed_at TEXT
    )`;
  }

  async init() {
    if (!this.ready) {
      this.ready = (async () => {
        this.lib.db.exec(this.#table());
      })();
    }
    return this.ready;
  }

  get(assetId) {
    const row = this.lib.db.prepare("SELECT * FROM asset_audio WHERE asset_id=?").get(assetId);
    return row || null;
  }

  /** 排队分析；同一时刻只跑一个 */
  analyze(assetId, { force = false } = {}) {
    const run = async () => {
      await this.init();
      const asset = this.lib.db.prepare("SELECT id,path,name,sha256 FROM assets WHERE id=?").get(assetId);
      if (!asset) throw Object.assign(new Error("素材不存在"), { code: "NOT_FOUND" });
      if (!fs.existsSync(this.engine.binaryPath)) {
        throw Object.assign(new Error("音频分析引擎未安装"), { code: "ENGINE_NOT_INSTALLED" });
      }
      const cached = this.get(assetId);
      if (!force && cached && cached.engine_version === this.engine.version && cached.sha256 === asset.sha256) {
        return { cached: true, ...cached };
      }
      const started = Date.now();
      const json = await this.#runEngine(asset.path);
      const parsed = normalize(json, asset, this.engine.version, Date.now() - started);
      this.#save(parsed);
      return { cached: false, ...parsed };
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  }

  #runEngine(file) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.engine.binaryPath, [file, "--json", "--brief"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(Object.assign(new Error("音频分析超时"), { code: "TIMEOUT" }));
      }, TIMEOUT_MS);
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(Object.assign(new Error(`引擎启动失败：${e.message}`), { code: "ENGINE_FAILED" }));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          return reject(Object.assign(new Error(`引擎退出码 ${code}：${err.slice(0, 200)}`), { code: "ENGINE_FAILED" }));
        }
        try {
          resolve(JSON.parse(out));
        } catch {
          reject(Object.assign(new Error("引擎输出不是合法 JSON"), { code: "BAD_OUTPUT" }));
        }
      });
    });
  }

  #save(rec) {
    const sql = this.lib.mysql
      ? `REPLACE INTO asset_audio (asset_id,sha256,bpm,key_root,key_mode,loudness_rms,loudness_peak,energy_min,energy_max,duration,structure_json,engine_version,analyzed_ms,analyzed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      : `INSERT OR REPLACE INTO asset_audio (asset_id,sha256,bpm,key_root,key_mode,loudness_rms,loudness_peak,energy_min,energy_max,duration,structure_json,engine_version,analyzed_ms,analyzed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
    this.lib.db
      .prepare(sql)
      .run(
        rec.asset_id,
        rec.sha256,
        rec.bpm,
        rec.key_root,
        rec.key_mode,
        rec.loudness_rms,
        rec.loudness_peak,
        rec.energy_min,
        rec.energy_max,
        rec.duration,
        rec.structure_json,
        rec.engine_version,
        rec.analyzed_ms,
        rec.analyzed_at,
      );
  }
}

function normalize(json, asset, version, ms) {
  const key = String(json?.key?.best || "");
  const m = key.match(/^([A-G][#b]?)\s*(minor|major)?/i);
  const structure = json?.form?.blocks || json?.blocks || null;
  return {
    asset_id: asset.id,
    sha256: asset.sha256 || null,
    bpm: Number(json?.bpm) || 0,
    key_root: m ? m[1] : null,
    key_mode: m && m[2] ? m[2].toLowerCase() : null,
    loudness_rms: Number(json?.loud?.rms ?? NaN) || null,
    loudness_peak: Number(json?.loud?.peak ?? NaN) || null,
    energy_min: Number(json?.energy?.min ?? NaN) || null,
    energy_max: Number(json?.energy?.max ?? NaN) || null,
    duration: Number(json?.dur) || null,
    structure_json: structure ? JSON.stringify(structure) : null,
    engine_version: version,
    analyzed_ms: ms,
    analyzed_at: new Date().toISOString(),
  };
}

export function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}
