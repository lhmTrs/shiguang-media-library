import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { stableFileSha256 } from "./fs-identity.mjs";

const HASH = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,36}$/;
const MAX_CACHE = 32 * 1024 * 1024;
const fail = (code, status = 409) => { throw Object.assign(new Error(code), { code, status }); };
const plain = x => x !== null && typeof x === "object" && !Array.isArray(x);
function keys(x, allowed) {
  if (!plain(x) || Object.keys(x).some(k => !allowed.includes(k))) fail("INVALID_TAG_METADATA", 400);
}
function scope(input = {}) {
  keys(input, ["mode", "groupId", "memberId"]);
  const value = { mode: input.mode || "SELF" };
  if (!["SELF", "GROUP", "MEMBER"].includes(value.mode)) fail("INVALID_TAG_METADATA", 400);
  if (value.mode === "SELF") {
    if (input.groupId != null || input.memberId != null) fail("INVALID_TAG_METADATA", 400);
  } else {
    if (!ID.test(input.groupId || "")) fail("INVALID_TAG_METADATA", 400);
    value.groupId = input.groupId;
    if (value.mode === "MEMBER") {
      if (!ID.test(input.memberId || "")) fail("INVALID_TAG_METADATA", 400);
      value.memberId = input.memberId;
    } else if (input.memberId != null) fail("INVALID_TAG_METADATA", 400);
  }
  return value;
}
function source(s) {
  if (!plain(s) || !ID.test(s.authorId || "") || !ID.test(s.incarnation || "") ||
      ![s.revision, s.policyVersion, s.count].every(Number.isSafeInteger) || s.revision < 0 || s.policyVersion < 0 || s.count < 0 || s.count > 5000 ||
      !["PUBLIC", "PRIVATE"].includes(s.visibility) || !HASH.test(s.stamp || "")) fail("TAG_RESPONSE_INVALID", 502);
  return { authorId: s.authorId, incarnation: s.incarnation, revision: s.revision, policyVersion: s.policyVersion, visibility: s.visibility, count: s.count, stamp: s.stamp };
}
function entry(e) {
  if (!plain(e) || !HASH.test(e.sha256 || "") || !Number.isSafeInteger(e.bytes) || e.bytes < 1 || !Array.isArray(e.tags) || !e.tags.length || e.tags.length > 40 ||
      e.tags.some(t => typeof t !== "string" || !t.trim() || t !== t.trim() || t.length > 60 || /[\x00-\x1f\x7f]/.test(t)) || new Set(e.tags).size !== e.tags.length) fail("TAG_RESPONSE_INVALID", 502);
  return { sha256: e.sha256, bytes: e.bytes, tags: [...e.tags] };
}

// Separate cache, never assets.tags/asset_tags or the audio upload DB. Construction
// is side-effect free; no connection, scan, file read or migration at app startup.
export class CloudTagsSync {
  constructor(lib, { cloudAuth, dataDir, db = null } = {}) {
    this.lib = lib; this.auth = cloudAuth; this.dataDir = dataDir; this.db = db;
    this.initialized = false; this.busy = false; this.rounds = new Map(); this.mutationEpoch = 0;
  }
  store() {
    if (!this.db) {
      const base = fs.realpathSync(this.dataDir), file = path.join(base, "cloud-tags-cache.sqlite");
      for (const name of [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]) {
        const stat = fs.lstatSync(name, { throwIfNoEntry: false });
        if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) fail("TAG_CACHE_UNSAFE", 503);
      }
      if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file, "wx", 0o600));
      fs.chmodSync(file, 0o600);
      this.db = new Database(file);
    }
    if (!this.initialized) {
      this.db.exec(`CREATE TABLE IF NOT EXISTS tag_replica_scopes(id TEXT PRIMARY KEY,namespace TEXT NOT NULL,inventory TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tag_replica_authors(scope TEXT NOT NULL,author TEXT NOT NULL,stamp TEXT NOT NULL,payload TEXT NOT NULL,visible INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(scope,author));
        CREATE TABLE IF NOT EXISTS tag_replica_versions(namespace TEXT NOT NULL,author TEXT NOT NULL,incarnation TEXT NOT NULL,revision INTEGER NOT NULL,policy INTEGER NOT NULL,admission TEXT NOT NULL,PRIMARY KEY(namespace,author));`);
      this.initialized = true;
    }
    return this.db;
  }
  identity() {
    const s = this.auth.getState();
    if (s.state !== "logged-in" || !ID.test(s.accountId || "") || !s.deviceId || !s.sessionId || !Number.isSafeInteger(this.auth.epoch)) fail("NOT_LOGGED_IN", 401);
    const origin = new URL(this.auth.config.origin).origin;
    return { epoch: this.auth.epoch, accountId: s.accountId, key: JSON.stringify([origin, s.accountId, s.deviceId, s.sessionId]) };
  }
  check(who) { if (this.identity().key !== who.key || this.auth.epoch !== who.epoch) fail("TAG_STALE_RESPONSE"); }
  async call(who, method, route, body) {
    this.check(who);
    try {
      const result = await this.auth.proxy(method, `/tag-metadata${route}`, { body, epoch: who.epoch });
      this.check(who); return result;
    } catch (error) {
      if (error.status === 401) {
        this.check(who); this.invalidateNamespace(who);
        if (typeof this.auth.forgetSession === "function") await this.auth.forgetSession("UNAUTHORIZED", { epoch: who.epoch });
      }
      throw error;
    }
  }
  key(who, selection) {
    // Persist by service/account, but bind every in-flight operation to device/session/epoch.
    return crypto.createHash("sha256").update(JSON.stringify([new URL(this.auth.config.origin).origin, who.accountId, selection])).digest("hex");
  }
  invalidateNamespace(who) {
    this.check(who);
    const db = this.store(), namespace = this.key(who, { mode: "SELF" }), fence = `REVOKED:${crypto.randomUUID()}`;
    // A denial may mean group/member/account revocation. Until a fresh successful
    // inventory narrows it, conservatively hide this service/account's replicas.
    // Scope fences include first-time staging with no committed author row yet.
    db.transaction(() => {
      db.prepare("UPDATE tag_replica_authors SET visible=0 WHERE scope IN (SELECT id FROM tag_replica_scopes WHERE namespace=?)").run(namespace);
      db.prepare("UPDATE tag_replica_versions SET admission=? WHERE namespace=?").run(fence, namespace);
      db.prepare("UPDATE tag_replica_scopes SET inventory=? WHERE namespace=?").run(fence, namespace);
    })();
  }
  async me() { const who = this.identity(); return source(await this.call(who, "GET", "/me")); }
  async policy(input) {
    keys(input, ["visibility", "expectedPolicyVersion"]);
    if (!["PUBLIC", "PRIVATE"].includes(input.visibility) || !Number.isSafeInteger(input.expectedPolicyVersion) || input.expectedPolicyVersion < 0) fail("INVALID_TAG_METADATA", 400);
    const who = this.identity();
    this.mutationEpoch++;
    return source(await this.call(who, "PUT", "/me/policy", input));
  }
  async put(input) {
    keys(input, ["sha256", "bytes", "tags", "expectedRevision", "expectedPolicyVersion"]);
    if (!Array.isArray(input.tags)) fail("INVALID_TAG_METADATA", 400);
    if (input.tags.length) entry(input);
    else if (!HASH.test(input.sha256 || "") || !Number.isSafeInteger(input.bytes) || input.bytes < 1) fail("INVALID_TAG_METADATA", 400);
    if (![input.expectedRevision, input.expectedPolicyVersion].every(n => Number.isSafeInteger(n) && n >= 0)) fail("INVALID_TAG_METADATA", 400);
    const who = this.identity(); this.mutationEpoch++;
    return source(await this.call(who, "PUT", "/me/entries", input));
  }
  candidates(q = "") {
    if (typeof q !== "string" || q.length > 200) fail("INVALID_TAG_METADATA", 400);
    // Names and IDs stay local. No metadata endpoint receives a filename/path.
    return this.lib.db.prepare(`SELECT id,name,tags FROM assets WHERE ${this.lib.activeAssetScope()} AND trashed=0 AND kind IN ('music','sfx') AND name LIKE ? ORDER BY name,id LIMIT 100`)
      .all(`%${q}%`).map(a => ({ id: a.id, name: a.name, tags: JSON.parse(a.tags) }));
  }
  async publishAsset(input) {
    keys(input, ["assetId", "expectedRevision", "expectedPolicyVersion"]);
    if (!ID.test(input.assetId || "")) fail("INVALID_TAG_METADATA", 400);
    if (this.busy) fail("TAG_SYNC_BUSY", 423);
    this.busy = true;
    try {
      const who = this.identity(), a = this.lib.asset(input.assetId), root = this.lib.rootById(a.root_id);
      const frozen = JSON.stringify([a, root]), deadline = Date.now() + 120000;
      const check = () => {
        this.check(who);
        if (Date.now() > deadline) fail("TAG_HASH_TIMEOUT", 408);
        if (a.trashed || root.retired || root.online !== 1 || !["music", "sfx"].includes(a.kind) || this.lib.locks.size ||
            this.lib.workers || this.lib.metadataPending.size || this.lib.metadataQueue.length) fail("TAG_SOURCE_CHANGED");
      };
      const snapshot = () => { check(); if (JSON.stringify([this.lib.asset(a.id), this.lib.rootById(root.id)]) !== frozen) fail("TAG_SOURCE_CHANGED"); };
      snapshot();
      const fingerprint = await stableFileSha256(root, a.path, { remainingBytes: 512_000_000, check });
      snapshot();
      if (!Array.isArray(a.tags)) fail("INVALID_TAG_METADATA", 400);
      return await this.put({ sha256: fingerprint.sha256, bytes: fingerprint.bytes, tags: a.tags,
        expectedRevision: input.expectedRevision, expectedPolicyVersion: input.expectedPolicyVersion });
    } finally { this.busy = false; }
  }
  cached(input = {}) {
    const selection = scope(input), who = this.identity(), db = this.store(), key = this.key(who, selection);
    const rows = db.prepare("SELECT author,payload FROM tag_replica_authors WHERE scope=? AND visible=1 ORDER BY CASE WHEN author=? THEN 0 ELSE 1 END,author").all(key, who.accountId);
    return { sources: rows.map(r => ({ authorId: r.author, own: r.author === who.accountId, items: JSON.parse(r.payload) })) };
  }
  async sync(input = {}) {
    const selection = scope(input), who = this.identity(), db = this.store(), key = this.key(who, selection);
    if (this.busy) fail("TAG_SYNC_BUSY", 423);
    this.busy = true;
    const round = crypto.randomUUID(), mutationEpoch = this.mutationEpoch;
    const namespace = this.key(who, { mode: "SELF" });
    this.rounds.set(key, round);
    const query = new URLSearchParams(selection).toString();
    const current = () => { this.check(who); if (this.rounds.get(key) !== round || this.mutationEpoch !== mutationEpoch) fail("TAG_STALE_RESPONSE"); };
    const hideAuthor = author => {
      db.prepare("UPDATE tag_replica_authors SET visible=0 WHERE author=? AND scope IN (SELECT id FROM tag_replica_scopes WHERE namespace=?)").run(author, namespace);
      db.prepare("UPDATE tag_replica_versions SET admission=? WHERE namespace=? AND author=?").run(crypto.randomUUID(), namespace, author);
    };
    try {
      let inventory;
      try { inventory = await this.call(who, "GET", `/sources?${query}`); }
      catch (error) {
        current();
        if (error.code === "TAG_SCOPE_REVOKED" || error.status === 401) this.invalidateNamespace(who);
        throw error;
      }
      current();
      if (!plain(inventory) || !HASH.test(inventory.scopeStamp || "") || !Array.isArray(inventory.sources) || inventory.sources.length > 501) fail("TAG_RESPONSE_INVALID", 502);
      const sources = inventory.sources.map(source);
      if (new Set(sources.map(s => s.authorId)).size !== sources.length || sources.filter(s => s.authorId === who.accountId).length !== 1 ||
          selection.mode === "SELF" && sources.length !== 1 || selection.mode === "MEMBER" && sources.some(s => s.authorId !== who.accountId && s.authorId !== selection.memberId) ||
          sources.some(s => s.authorId !== who.accountId && s.visibility !== "PUBLIC")) fail("TAG_RESPONSE_INVALID", 502);
      const old = db.prepare("SELECT inventory FROM tag_replica_scopes WHERE id=?").get(key);
      if (!old && db.prepare("SELECT COUNT(*) n FROM tag_replica_scopes").get().n >= 8) fail("TAG_CACHE_LIMIT", 429);
      db.transaction(() => {
        db.prepare("INSERT INTO tag_replica_scopes(id,namespace,inventory) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET inventory=excluded.inventory").run(key, namespace, inventory.scopeStamp);
        // A successful complete authorization inventory hides revoked and changed
        // sources before any page download. Data remains isolated, not erased.
        for (const row of db.prepare("SELECT author,stamp FROM tag_replica_authors WHERE scope=?").all(key)) {
          const s = sources.find(s => s.authorId === row.author);
          if (!s || s.stamp !== row.stamp) db.prepare("UPDATE tag_replica_authors SET visible=0 WHERE scope=? AND author=?").run(key, row.author);
        }
        // Revocation is not view-specific: another cached scope must not leak it.
        if (selection.mode !== "SELF") {
          const knownAuthors = new Set(sources.map(s => s.authorId));
          for (const row of db.prepare("SELECT DISTINCT author FROM tag_replica_authors WHERE scope=?").all(key)) {
            if (!knownAuthors.has(row.author)) hideAuthor(row.author);
          }
        }
      })();
      const completed = [], deferred = [];
      for (const s of sources) {
        current();
        let items = [], offset = 0, bytes = 0, previous = "";
        try {
          const admission = crypto.randomUUID();
          const admitted = db.transaction(() => {
            const high = db.prepare("SELECT * FROM tag_replica_versions WHERE namespace=? AND author=?").get(namespace, s.authorId);
            if (high && (s.incarnation !== high.incarnation || s.revision < high.revision || s.policyVersion < high.policy)) {
              hideAuthor(s.authorId); return false;
            }
            if (high && (s.revision !== high.revision || s.policyVersion !== high.policy)) hideAuthor(s.authorId);
            db.prepare("INSERT INTO tag_replica_versions(namespace,author,incarnation,revision,policy,admission) VALUES(?,?,?,?,?,?) ON CONFLICT(namespace,author) DO UPDATE SET revision=excluded.revision,policy=excluded.policy,admission=excluded.admission")
              .run(namespace, s.authorId, s.incarnation, s.revision, s.policyVersion, admission);
            return true;
          })();
          if (!admitted) fail("TAG_NAMESPACE_RECHECK_REQUIRED");
          do {
            const p = await this.call(who, "GET", `/sources/${s.authorId}?${query}&stamp=${s.stamp}&offset=${offset}`);
            current();
            if (!plain(p) || JSON.stringify(source(p.source)) !== JSON.stringify(s) || p.offset !== offset || !Array.isArray(p.items) || p.items.length > 100) fail("TAG_RESPONSE_INVALID", 502);
            const page = p.items.map(entry);
            for (const e of page) {
              const order = `${e.sha256}:${String(e.bytes).padStart(16, "0")}`;
              if (order <= previous) fail("TAG_RESPONSE_INVALID", 502);
              previous = order; bytes += Buffer.byteLength(JSON.stringify(e));
              if (bytes > 8 * 1024 * 1024) fail("TAG_CACHE_LIMIT", 429);
            }
            items.push(...page);
            const next = offset + page.length;
            if (next > s.count || p.nextOffset !== (next < s.count ? next : null) || next < s.count && page.length !== 100) fail("TAG_RESPONSE_INVALID", 502);
            offset = next;
          } while (offset < s.count);
          // Final current authorization/version check, including an empty author.
          const final = await this.call(who, "GET", `/sources/${s.authorId}?${query}&stamp=${s.stamp}&offset=0`);
          current(); if (JSON.stringify(source(final.source)) !== JSON.stringify(s)) fail("TAG_RESPONSE_INVALID", 502);
          const payload = JSON.stringify(items);
          db.transaction(() => {
            const high = db.prepare("SELECT admission FROM tag_replica_versions WHERE namespace=? AND author=?").get(namespace, s.authorId);
            if (high?.admission !== admission || db.prepare("SELECT inventory FROM tag_replica_scopes WHERE id=?").get(key)?.inventory !== inventory.scopeStamp) fail("TAG_STALE_RESPONSE");
            const oldBytes = db.prepare("SELECT length(CAST(payload AS BLOB)) n FROM tag_replica_authors WHERE scope=? AND author=?").get(key, s.authorId)?.n || 0;
            const total = db.prepare("SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) n FROM tag_replica_authors").get().n;
            if (total - oldBytes + Buffer.byteLength(payload) > MAX_CACHE) fail("TAG_CACHE_LIMIT", 429);
            db.prepare("INSERT INTO tag_replica_authors(scope,author,stamp,payload,visible) VALUES(?,?,?,?,1) ON CONFLICT(scope,author) DO UPDATE SET stamp=excluded.stamp,payload=excluded.payload,visible=1").run(key, s.authorId, s.stamp, payload);
          })();
          completed.push(s.authorId);
        } catch (error) {
          current();
          if (error.code === "TAG_SCOPE_REVOKED") this.invalidateNamespace(who);
          if (error.code === "TAG_VERSION_CHANGED") hideAuthor(s.authorId);
          if (error.status === 401) { this.invalidateNamespace(who); throw error; }
          deferred.push({ authorId: s.authorId, code: /^[A-Z_]{1,64}$/.test(error.code || "") ? error.code : "TAG_SYNC_DEFERRED" });
        }
      }
      return { completed, deferred, ...this.cached(selection) };
    } finally { this.busy = false; this.rounds.delete(key); }
  }
  close() { if (this.busy) fail("TAG_SYNC_BUSY", 423); this.db?.close(); this.db = null; this.initialized = false; }
}
