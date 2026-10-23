import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Library } from "../server/library.mjs";
import { Projects } from "../server/projects.mjs";
import { RootRemoval } from "../server/root-removal.mjs";

async function setup(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "root-removal-test-")));
  const lib = await new Library(path.join(base,"data")).init();lib.enqueue=()=>{};
  const projects = new Projects(lib).init();
  const source = path.join(base,"source"), other = path.join(base,"other");
  await fs.mkdir(source);await fs.mkdir(other);
  const root = await lib.addRoot(source,"sfx"), keptRoot = await lib.addRoot(other,"sfx");
  const add=(id,r=root)=>lib.db.prepare("INSERT INTO assets(id,root_id,path,name,kind,ext,tags,note,favorite) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(id,r.id,path.join(r.path,`${id}.wav`),`${id}.wav`,"sfx","wav",'["test-tag"]',"test-note",1);
  add("a");add("keep",keptRoot);
  await fs.writeFile(path.join(source,"a.wav"),"original stays untouched");
  lib.retireRoot(root.id);
  const removal=new RootRemoval(lib);
  t.after(async()=>{lib.db.close();await fs.rm(base,{recursive:true,force:true});});
  return {lib,projects,root,keptRoot,source,removal,base,add};
}

test("移除有索引的目录：先备份、清关联、不删原文件或其他目录",async t=>{
  const {lib,projects,root,source,removal}=await setup(t);
  lib.db.exec("CREATE TABLE extra_results(asset_id TEXT PRIMARY KEY,root_id TEXT,payload TEXT)");
  lib.db.prepare("INSERT INTO extra_results VALUES(?,?,?)").run("a",root.id,"analysis");
  lib.db.prepare("INSERT INTO operations(id,asset_id,status) VALUES(?,?,?)").run("op","a","done");
  const p=projects.save(null,{name:"project",software:"resolve",note:""});
  // Preserve the project itself but remove its asset association.
  lib.db.prepare("INSERT INTO project_assets(id,project_id,asset_id,status,note,source,added_at,updated_at,snapshot) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("link",p.id,"a","used","","manual",1,1,"{}");
  const preview=removal.preview(root.id,"session");
  assert.equal(preview.assets,1);assert.equal(preview.projectLinks,1);assert.equal(preview.tagged,1);
  const result=await removal.execute(root.id,preview.confirmation,"session");
  assert.equal(result.removedAssets,1);
  assert.equal(await fs.readFile(path.join(source,"a.wav"),"utf8"),"original stays untouched");
  assert.equal(lib.db.prepare("SELECT COUNT(*) n FROM assets WHERE id='a'").get().n,0);
  assert.equal(lib.db.prepare("SELECT COUNT(*) n FROM operations").get().n,0);
  assert.equal(lib.db.prepare("SELECT COUNT(*) n FROM extra_results").get().n,0);
  assert.equal(lib.db.prepare("SELECT COUNT(*) n FROM project_assets").get().n,0);
  assert.equal(projects.get(p.id).name,"project");assert.equal(lib.asset("keep").id,"keep");
  const backup=JSON.parse(await fs.readFile(path.join(lib.dataDir,result.backup),"utf8"));
  assert.equal(backup.snapshot.assets[0].note,"test-note");assert.equal(backup.snapshot.root.id,root.id);
  assert.equal((await fs.stat(path.join(lib.dataDir,result.backup))).mode & 0o777,0o600);
  await assert.rejects(()=>removal.execute(root.id,preview.confirmation,"session"),/失效/);
});

test("5678条索引不受SQL参数数量限制",async t=>{
  const {lib,root,removal,add}=await setup(t);
  lib.db.transaction(()=>{for(let i=1;i<5678;i++)add(`asset-${i}`);})();
  const preview=removal.preview(root.id,"s");assert.equal(preview.assets,5678);
  const result=await removal.execute(root.id,preview.confirmation,"s");assert.equal(result.removedAssets,5678);
  assert.equal(lib.db.prepare("SELECT COUNT(*) n FROM assets").get().n,1);
});

test("预览会话、数据库身份、过期和素材变化均需要重新确认",async t=>{
  const {lib,root,removal}=await setup(t);
  const p=removal.preview(root.id,"s");
  await assert.rejects(()=>removal.execute(root.id,p.confirmation,"other"),/失效/);
  lib.db.prepare("UPDATE assets SET note='changed' WHERE id='a'").run();
  await assert.rejects(()=>removal.execute(root.id,p.confirmation,"s"),/变化/);
  const expired=removal.preview(root.id,"s");removal.previews.get(expired.confirmation).createdAt-=600001;
  await assert.rejects(()=>removal.execute(root.id,expired.confirmation,"s"),/失效/);
  const identity=removal.preview(root.id,"s");removal.previews.get(identity.confirmation).db={};
  await assert.rejects(()=>removal.execute(root.id,identity.confirmation,"s"),/失效/);
  assert.equal(lib.asset("a").note,"changed");assert.ok(lib.rootById(root.id));
});

test("备份失败、事务失败均保留全部记录",async t=>{
  const {lib,root,removal}=await setup(t);
  const directory=path.join(lib.dataDir,"root-removal-backups");await fs.writeFile(directory,"not directory");
  let p=removal.preview(root.id,"s");await assert.rejects(()=>removal.execute(root.id,p.confirmation,"s"));
  assert.ok(lib.asset("a"));await fs.unlink(directory);
  lib.db.exec("CREATE TRIGGER prevent_root_delete BEFORE DELETE ON roots BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  p=removal.preview(root.id,"s");await assert.rejects(()=>removal.execute(root.id,p.confirmation,"s"),/synthetic failure/);
  assert.ok(lib.asset("a"));assert.ok(lib.rootById(root.id));assert.equal(removal.active,false);
  assert.equal((await fs.readdir(directory)).length,1);
});

test("活动目录、任务、素材锁与未完成文件操作阻止移除",async t=>{
  const {lib,root,removal}=await setup(t);
  lib.restoreRoot(root.id);assert.throws(()=>removal.preview(root.id,"s"),/先注销/);lib.retireRoot(root.id);
  lib.locks.add("a");assert.throws(()=>removal.preview(root.id,"s"),/操作正在/);lib.locks.clear();
  lib.jobs.set("job",{status:"running"});assert.throws(()=>removal.preview(root.id,"s"),/操作正在/);lib.jobs.clear();
  lib.db.prepare("INSERT INTO operations(id,asset_id,status) VALUES(?,?,?)").run("pending","a","pending");
  assert.throws(()=>removal.preview(root.id,"s"),/尚未完成/);
});

test("备份期间出现新修改时拒绝删除并保留新数据",async t=>{
  const {lib,root,removal}=await setup(t);
  const p=removal.preview(root.id,"s");
  const pending=removal.execute(root.id,p.confirmation,"s");
  lib.db.prepare("UPDATE assets SET note='new edit during backup' WHERE id='a'").run();
  await assert.rejects(()=>pending,/备份期间记录发生变化/);
  assert.equal(lib.asset("a").note,"new edit during backup");assert.ok(lib.rootById(root.id));
});

test("时间线变为未匹配引用，旧导入撤销不可复活已移除素材",async t=>{
  const {lib,projects,root,removal}=await setup(t);
  const project=projects.save(null,{name:"timeline-project",software:"resolve",note:""});
  const snapshot={refs:[{assetId:"a",used:true,name:"a.wav",occurrences:[]},{assetId:"keep",used:true,name:"keep.wav",occurrences:[]}]};
  lib.db.prepare("INSERT INTO project_timelines(id,project_id,name,snapshot,revision,head_id,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run("timeline",project.id,"Timeline",JSON.stringify(snapshot),"r","batch",1);
  lib.db.prepare("INSERT INTO project_timeline_batches(id,project_id,timeline_id,payload,status,created_at) VALUES(?,?,?,?,?,?)")
    .run("batch",project.id,"timeline",JSON.stringify({affected:["a","keep"]}),"applied",1);
  const p=removal.preview(root.id,"s");assert.equal(p.timelines,1);
  await removal.execute(root.id,p.confirmation,"s");
  const timeline=lib.db.prepare("SELECT * FROM project_timelines").get(), after=JSON.parse(timeline.snapshot);
  assert.equal(after.refs[0].assetId,null);assert.equal(after.refs[0].used,false);assert.equal(after.refs[1].assetId,"keep");
  assert.equal(lib.db.prepare("SELECT status FROM project_timeline_batches").get().status,"invalidated");
  assert.throws(()=>projects.imports.undo(project.id,"batch"),/只能撤销/);
});
