import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import mysql from "mysql2/promise";
import {Library} from "../server/library.mjs";
import {MysqlStorage} from "../server/mysql.mjs";
import {Projects} from "../server/projects.mjs";
import {RootRemoval} from "../server/root-removal.mjs";

// This script creates its own loopback-only disposable container; it never accepts an existing DB config.
const exec=promisify(execFile), name=`sg-root-removal-${process.pid}`;
const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"root-removal-mysql-")));
let started=false,lib;
try{
  await exec("docker",["run","--rm","-d","--name",name,"-e","MYSQL_ALLOW_EMPTY_PASSWORD=1","-e","MYSQL_DATABASE=fixture","-p","127.0.0.1::3306","mysql:8.4"]);started=true;
  const {stdout}=await exec("docker",["inspect",name]);
  const port=Number(JSON.parse(stdout)[0].NetworkSettings.Ports["3306/tcp"][0].HostPort);
  const config={host:"127.0.0.1",port,user:"root",password:"",database:"fixture"};
  let ready=false;
  for(let i=0;i<150;i++){
    try{const conn=await mysql.createConnection({...config,connectTimeout:500});await conn.end();ready=true;break;}
    catch{await new Promise(r=>setTimeout(r,200));}
  }
  assert.ok(ready,"Disposable database start timeout");
  lib=await new Library(path.join(base,"data")).init();lib.enqueue=()=>{};
  const storage=await new MysqlStorage(lib.dataDir).init();storage.attach(lib);
  await storage.activate(config);
  const source=path.join(base,"source");await fs.mkdir(source);await fs.writeFile(path.join(source,"a.wav"),"original");
  const root=await lib.addRoot(source,"sfx");
  lib.db.prepare("INSERT INTO assets(id,root_id,path,name,kind,ext,tags,note,favorite) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("a",root.id,path.join(source,"a.wav"),"a.wav","sfx","wav",'["tag"]',"note",1);
  const projects=new Projects(lib).init();const project=projects.save(null,{name:"test",software:"resolve",note:""});
  projects.add(project.id,{ids:["a"]});
  lib.retireRoot(root.id);const removal=new RootRemoval(lib);
  const preview=removal.preview(root.id,"s");assert.equal(preview.assets,1);assert.equal(preview.projectLinks,1);
  const result=await removal.execute(root.id,preview.confirmation,"s");assert.equal(result.removedAssets,1);
  assert.equal(Number(lib.db.prepare("SELECT COUNT(*) n FROM assets").get().n),0);
  assert.equal(Number(lib.db.prepare("SELECT COUNT(*) n FROM project_assets").get().n),0);
  assert.equal(Number(lib.db.prepare("SELECT COUNT(*) n FROM project_manual_assets").get().n),0);
  assert.equal(Number(lib.db.prepare("SELECT COUNT(*) n FROM roots").get().n),0);
  assert.equal(projects.get(project.id).name,"test");
  assert.equal(await fs.readFile(path.join(source,"a.wav"),"utf8"),"original");
  assert.equal(JSON.parse(await fs.readFile(path.join(lib.dataDir,result.backup),"utf8")).snapshot.assets[0].note,"note");
  console.log("PASS: disposable MySQL8.4 metadata removal, transactional revalidation, project preservation, backup, original untouched");
}finally{
  lib?.db.close();
  if(started)await exec("docker",["rm","-f",name]);
  await fs.rm(base,{recursive:true,force:true});
}
