import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { CloudTagsSync } from "../server/cloud-tags-sync.mjs";
import { Library } from "../server/library.mjs";

const hash = n => n.toString(16).padStart(64, "0");
const item = n => ({ sha256: hash(n), bytes: 123, tags: ["合成标签"] });
function fixture(t) {
  const db = new Database(":memory:"), calls = [], remote = new Map([["self", { revision: 0, policy: 0, visibility: "PRIVATE", items: [] }]]);
  const auth = { epoch: 1, config: { origin: "https://tags.invalid" }, state: { state: "logged-in", accountId: "self", deviceId: "device", sessionId: "session" }, getState() { return this.state; } };
  let before = null;
  function descriptor(id, selection) {
    const a = remote.get(id);
    const s = { authorId: id, incarnation: `${id}-incarnation`, revision: a.revision, policyVersion: a.policy, visibility: a.visibility, count: a.items.length };
    return { ...s, stamp: crypto.createHash("sha256").update(JSON.stringify([selection, s])).digest("hex") };
  }
  auth.proxy = async (method, route, options) => {
    calls.push({ method, route, body: options.body });
    if (before) await before(method, route, options);
    assert.ok(route.startsWith("/tag-metadata/"), "only tag routes are permitted");
    const url = new URL(route, "https://tags.invalid"), s = { mode: url.searchParams.get("mode") || "SELF", ...(url.searchParams.has("groupId") ? { groupId: url.searchParams.get("groupId") } : {}), ...(url.searchParams.has("memberId") ? { memberId: url.searchParams.get("memberId") } : {}) };
    const me = remote.get(auth.state.accountId);
    if (url.pathname.endsWith("/me")) return descriptor(auth.state.accountId, "me");
    if (method === "PUT") {
      const b = options.body;
      if (b.expectedPolicyVersion !== me.policy || b.expectedRevision !== undefined && b.expectedRevision !== me.revision) throw Object.assign(Error("stale"), { code: "TAG_VERSION_CHANGED", status: 409 });
      if (url.pathname.endsWith("/policy")) { me.visibility = b.visibility; me.policy++; }
      else { const at = me.items.findIndex(e => e.sha256 === b.sha256 && e.bytes === b.bytes); if (at >= 0) me.items.splice(at, 1); if (b.tags.length) me.items.push({ sha256: b.sha256, bytes: b.bytes, tags: b.tags }); me.items.sort((a,b) => a.sha256.localeCompare(b.sha256)); me.revision++; }
      return descriptor(auth.state.accountId, "me");
    }
    const ids = [...remote.keys()].filter(id => id === auth.state.accountId || s.mode !== "SELF" && remote.get(id).visibility === "PUBLIC" && (s.mode === "GROUP" || id === s.memberId));
    if (url.pathname.endsWith("/sources")) return { scopeStamp: "f".repeat(64), sources: ids.map(id => descriptor(id, s)) };
    const id = url.pathname.split("/").at(-1);
    if (!ids.includes(id)) throw Object.assign(Error("revoked"), { code: "TAG_SCOPE_REVOKED", status: 403 });
    const source = descriptor(id, s);
    if (url.searchParams.get("stamp") !== source.stamp) throw Object.assign(Error("changed"), { code: "TAG_VERSION_CHANGED", status: 409 });
    const offset = Number(url.searchParams.get("offset")), items = structuredClone(remote.get(id).items.slice(offset, offset + 100));
    return { source, offset, nextOffset: offset + items.length < source.count ? offset + items.length : null, items };
  };
  const lib = { db: new Database(":memory:") };
  const sync = new CloudTagsSync(lib, { cloudAuth: auth, db });
  t.after(() => { sync.close(); lib.db.close(); });
  return { sync, db, remote, auth, calls, hook: fn => { before = fn; }, lib };
}
const group = { mode: "GROUP", groupId: "group" }, member = { mode: "MEMBER", groupId: "group", memberId: "alice" };
test("tag metadata publication and sync never require an audio object, upload approval or bytes", async t => {
  const { sync, calls, lib } = fixture(t);
  lib.audio = new Proxy({}, { get() { assert.fail("audio module must not be used"); } });
  await sync.put({ sha256: hash(1), bytes: 123, tags: ["合成标签"], expectedRevision: 0, expectedPolicyVersion: 0 });
  const result = await sync.sync();
  assert.equal(result.sources[0].items[0].sha256, hash(1));
  assert.deepEqual(calls.find(c => c.method === "PUT").body, { sha256: hash(1), bytes: 123, tags: ["合成标签"], expectedRevision: 0, expectedPolicyVersion: 0 });
  assert.ok(calls.every(c => !/upload|media\/audio|content\//.test(c.route)));
  await assert.rejects(sync.put({ sha256: hash(1), bytes: 123, tags: ["x"], expectedRevision: 1, expectedPolicyVersion: 0, path: "/private" }), e => e.code === "INVALID_TAG_METADATA");
});
test("incomplete author pages are invisible while other complete authors remain available", async t => {
  const { sync, remote, hook } = fixture(t);
  remote.get("self").items = [item(1)];
  remote.set("alice", { revision: 1, policy: 1, visibility: "PUBLIC", items: Array.from({ length: 101 }, (_,i) => item(i+10)) });
  let release, arrived;
  const gate = new Promise(r => { release = r; }), reached = new Promise(r => { arrived = r; });
  hook(async (_, route) => { if (route.includes("sources/alice") && route.endsWith("offset=100")) { arrived(); await gate; } });
  const pending = sync.sync(group); await reached;
  assert.deepEqual(sync.cached(group).sources.map(s => s.authorId), ["self"]);
  await assert.rejects(sync.sync(group), e => e.code === "TAG_SYNC_BUSY");
  release(); const result = await pending;
  assert.deepEqual(result.completed, ["self", "alice"]);assert.equal(result.sources[1].items.length, 101);
});
test("network errors preserve data, and failed new versions never expose partial pages or erase payloads", async t => {
  const { sync, remote, hook, db } = fixture(t);
  remote.set("alice", { revision: 1, policy: 1, visibility: "PUBLIC", items: [item(2)] });
  await sync.sync(group);
  hook(async (_, route) => { if (route.endsWith("sources?mode=GROUP&groupId=group")) throw Error("synthetic disconnected"); });
  await assert.rejects(sync.sync(group));assert.equal(sync.cached(group).sources.length, 2);
  remote.get("alice").revision++;remote.get("alice").items = Array.from({ length: 101 }, (_,i) => item(i+10));
  hook(async (_, route) => { if (route.includes("sources/alice") && route.endsWith("offset=100")) throw Error("synthetic missing page"); });
  const result = await sync.sync(group);
  assert.equal(result.deferred[0].authorId, "alice");assert.deepEqual(sync.cached(group).sources.map(s => s.authorId), ["self"]);
  const payload = db.prepare("SELECT payload,visible FROM tag_replica_authors WHERE author='alice'").get();
  assert.equal(JSON.parse(payload.payload)[0].sha256, hash(2));assert.equal(payload.visible, 0);
});
test("valid revoke hides all cached views without deleting own or another author's same-name tag", async t => {
  const { sync, remote, db } = fixture(t);
  remote.get("self").items=[item(1)];remote.set("alice", { revision: 1, policy: 1, visibility: "PUBLIC", items: [item(1)] });
  await sync.sync(group);await sync.sync(member);
  remote.get("alice").visibility="PRIVATE";remote.get("alice").policy++;
  await sync.sync(group);
  assert.deepEqual(sync.cached(group).sources.map(s => s.authorId), ["self"]);
  assert.deepEqual(sync.cached(member).sources.map(s => s.authorId), ["self"]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tag_replica_authors WHERE author='alice'").get().n, 2);
});
test("late response after account/session change never activates old-account data", async t => {
  const { sync, auth, remote, hook, db } = fixture(t);
  remote.get("self").items=[item(1)];let switched=false;
  hook(async (_, route) => { if (!switched && route.includes("sources/self")) { switched=true;auth.epoch++;auth.state={...auth.state,accountId:"other",sessionId:"other-session"};remote.set("other",{revision:0,policy:0,visibility:"PRIVATE",items:[]}); } });
  await assert.rejects(sync.sync(), e => e.code === "TAG_STALE_RESPONSE");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tag_replica_authors").get().n,0);assert.deepEqual(sync.cached().sources,[]);
});
test("rollback is held for recheck and service/account namespaces do not contaminate each other", async t => {
  const { sync, auth, remote } = fixture(t);
  remote.get("self").revision=5;remote.get("self").items=[item(1)];await sync.sync();
  auth.config.origin="https://another-tags.invalid";remote.get("self").revision=0;remote.get("self").items=[item(2)];await sync.sync();
  assert.equal(sync.cached().sources[0].items[0].sha256,hash(2));
  auth.config.origin="https://tags.invalid";const result=await sync.sync();
  assert.equal(result.deferred[0].code,"TAG_NAMESPACE_RECHECK_REQUIRED");assert.deepEqual(sync.cached().sources,[]);
});
test("malformed authorization inventory cannot be interpreted as deleting all authors", async t => {
  const { sync, auth } = fixture(t);await sync.sync();
  const original = auth.proxy;
  auth.proxy = async (...args) => args[1].includes("sources?") ? {scopeStamp:"f".repeat(64),sources:[]} : original(...args);
  await assert.rejects(sync.sync(),e=>e.code==="TAG_RESPONSE_INVALID");
  assert.equal(sync.cached().sources.length,1);
});
test("a persisted revoke fence invalidates an already-downloaded late response", async t => {
  const { sync, hook, db, remote } = fixture(t);remote.get("self").items=[item(1)];
  let pages=0;
  hook(async (_, route) => {
    if (route.includes("sources/self") && ++pages===2) db.prepare("UPDATE tag_replica_versions SET admission='revoked-by-other-owner'").run();
  });
  const result=await sync.sync();
  assert.equal(result.deferred[0].code,"TAG_STALE_RESPONSE");assert.deepEqual(sync.cached().sources,[]);
});
test("policy mutation during download invalidates the old sync generation", async t => {
  const { sync, remote, hook }=fixture(t);remote.get("self").items=[item(1)];
  let changed=false;
  hook(async (_, route)=>{ if (!changed && route.includes("sources/self")) { changed=true;await sync.policy({visibility:"PUBLIC",expectedPolicyVersion:0}); } });
  await assert.rejects(sync.sync(),e=>e.code==="TAG_STALE_RESPONSE");assert.deepEqual(sync.cached().sources,[]);
});
test("known group revocation hides all same-namespace views and preserves payloads", async t => {
  const {sync,auth,remote,db}=fixture(t);
  remote.set("alice",{revision:1,policy:1,visibility:"PUBLIC",items:[item(1)]});
  await sync.sync(group);await sync.sync(member);
  const count=db.prepare("SELECT COUNT(*) n FROM tag_replica_authors").get().n, original=auth.proxy;
  auth.proxy=async (...args)=>{if(args[1].includes("/sources?"))throw Object.assign(Error("revoked"),{code:"TAG_SCOPE_REVOKED",status:403});return original(...args);};
  await assert.rejects(sync.sync(group),e=>e.code==="TAG_SCOPE_REVOKED");
  assert.deepEqual(sync.cached(member).sources,[]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tag_replica_authors").get().n,count);
});
test("known group revocation fences another owner's prevalidated final response", async t => {
  const {sync,auth,remote,db}=fixture(t);
  remote.set("alice",{revision:1,policy:1,visibility:"PUBLIC",items:[item(1)]});
  await sync.sync(group);await sync.sync(member);
  const other=new CloudTagsSync({}, {cloudAuth:auth,db}),original=auth.proxy;
  let pages=0,revoked=false,ready,release;
  const reached=new Promise(r=>{ready=r;}),gate=new Promise(r=>{release=r;});
  auth.proxy=async (...args)=>{
    if(revoked)throw Object.assign(Error("revoked"),{code:"TAG_SCOPE_REVOKED",status:403});
    const result=await original(...args);
    if(args[1].includes("/sources/alice?")&&args[1].includes("mode=MEMBER")&&++pages===2){ready();await gate;}
    return result;
  };
  const pending=other.sync(member);await reached;revoked=true;
  await assert.rejects(sync.sync(group),e=>e.code==="TAG_SCOPE_REVOKED");release();
  const result=await pending;
  assert.equal(result.sources.some(s=>s.authorId==="alice"),false);
  assert.equal(result.deferred.some(s=>s.code==="TAG_STALE_RESPONSE"),true);
});
test("401 masks every namespace view, and a newly known version change hides the old author", async t => {
  const {sync,auth,remote}=fixture(t);remote.set("alice",{revision:1,policy:1,visibility:"PUBLIC",items:[item(1)]});
  await sync.sync(group);await sync.sync(member);const original=auth.proxy;
  auth.proxy=async (...args)=>{if(args[1].includes("/sources/alice?"))throw Object.assign(Error("changed"),{code:"TAG_VERSION_CHANGED",status:409});return original(...args);};
  const result=await sync.sync(member);assert.equal(result.sources.some(s=>s.authorId==="alice"),false);
  auth.proxy=async()=>{throw Object.assign(Error("revoked session"),{code:"UNAUTHORIZED",status:401});};
  await assert.rejects(sync.me(),e=>e.status===401);assert.deepEqual(sync.cached(group).sources,[]);
});
test("explicit publication hashes only the selected synthetic file and sends no filename/path/media payload", async t => {
  const { sync, lib, calls } = fixture(t);
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"tag-content-only-"))), file=path.join(dir,"renamed-synthetic.wav");
  t.after(() => fs.rm(dir,{recursive:true,force:true}));await fs.writeFile(file,"synthetic bytes, not author media");
  const a={id:"synthetic",path:file,root_id:"root",kind:"sfx",tags:["合成标签"],trashed:0}, root={id:"root",path:dir,online:1,retired:0};
  lib.asset=()=>a;lib.rootById=()=>root;lib.locks=new Set();lib.workers=0;lib.metadataPending=new Set();lib.metadataQueue=[];
  await sync.publishAsset({assetId:a.id,expectedRevision:0,expectedPolicyVersion:0});
  const body=calls.find(c=>c.method==="PUT").body;
  assert.equal(body.sha256,crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex"));
  assert.ok(!JSON.stringify(body).includes(file));assert.ok(!("fileName" in body));assert.ok(!("assetId" in body));
  assert.deepEqual(a.tags,["合成标签"]);assert.deepEqual(await fs.readdir(dir),["renamed-synthetic.wav"]);
});
test("actual Library parsed tags and root/asset queries publish from a new SQLite library", async t => {
  const f=fixture(t), base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"tag-real-library-")));
  const rootPath=path.join(base,"synthetic-media");await fs.mkdir(rootPath);
  const file=path.join(rootPath,"synthetic.wav");await fs.writeFile(file,"synthetic bytes only");
  const lib=await new Library(path.join(base,"fresh-data")).init();
  const cache=new Database(":memory:"), sync=new CloudTagsSync(lib,{cloudAuth:f.auth,db:cache});
  t.after(async()=>{sync.close();lib.db.close();await fs.rm(base,{recursive:true,force:true});});
  const root=crypto.randomUUID(),asset=crypto.randomUUID(),stat=await fs.stat(file);
  lib.db.prepare("INSERT INTO roots(id,path,kind,name) VALUES(?,?,?,?)").run(root,rootPath,"sfx","Synthetic");
  lib.db.prepare("INSERT INTO assets(id,root_id,path,name,ext,kind,size,mtime,tags) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(asset,root,file,"synthetic.wav","wav","sfx",stat.size,stat.mtimeMs,'["真实接口夹具"]');
  assert.deepEqual(lib.asset(asset).tags,["真实接口夹具"]);
  assert.equal(sync.candidates("synthetic")[0].id,asset);
  await sync.publishAsset({assetId:asset,expectedRevision:0,expectedPolicyVersion:0});
  const result=await sync.sync();assert.deepEqual(result.sources[0].items[0].tags,["真实接口夹具"]);
  assert.deepEqual(lib.asset(asset).tags,["真实接口夹具"]);
  assert.equal(await fs.readFile(file,"utf8"),"synthetic bytes only");
  assert.deepEqual(await fs.readdir(rootPath),["synthetic.wav"]);
});
