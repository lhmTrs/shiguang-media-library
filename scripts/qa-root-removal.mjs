import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium, expect } from "@playwright/test";
import { Library } from "../server/library.mjs";

const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"root-removal-ui-")));
const data=path.join(base,"data"), source=path.join(base,"synthetic-source");
await fs.mkdir(source);await fs.writeFile(path.join(source,"fixture.wav"),"synthetic-original");
await fs.writeFile(path.join(base,"disabled-release.json"),JSON.stringify({enabled:false}));
const lib=await new Library(data).init();lib.enqueue=()=>{};
const root=await lib.addRoot(source,"sfx");
lib.db.prepare("INSERT INTO assets(id,root_id,path,name,ext,kind,probe,capture_status,tags,note) VALUES(?,?,?,?,?,?,?,?,?,?)")
  .run("fixture",root.id,path.join(source,"fixture.wav"),"fixture.wav","wav","sfx","ready","ready",'["test"]',"backup me");
lib.retireRoot(root.id);lib.db.close();
const server=spawn(process.execPath,["server/index.mjs"],{env:{...process.env,MEDIA_DATA_DIR:data,MEDIA_SKIP_IMPORT:"1",MEDIA_NO_WATCH:"1",SHIGUANG_CLOUD_RELEASE_CONFIG:path.join(base,"disabled-release.json"),PORT:"4598"},stdio:["ignore","pipe","pipe"]});
let logs="",browser;
server.stdout.on("data",b=>logs+=b);server.stderr.on("data",b=>logs+=b);
try {
  let url;
  for(let i=0;i<300;i++){
    await new Promise(r=>setTimeout(r,100));url=logs.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if(url)break;if(server.exitCode!==null)throw Error("Isolated server failed to start");
  }
  assert.ok(url,"Isolated server start timeout");
  browser=await chromium.launch({headless:true,...(process.platform==="darwin"?{executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}:{})});
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  const errors=[];page.on("pageerror",e=>errors.push(e.message));
  await page.goto(url);
  const opener=page.getByRole("button",{name:"添加素材目录",exact:true});await opener.click();
  await expect(page.getByRole("button",{name:"移除管理记录",exact:true})).toBeVisible();
  let confirmed=false;
  page.once("dialog",async dialog=>{
    assert.match(dialog.message(),/素材索引：1 条/);assert.match(dialog.message(),/原文件不会删除/);confirmed=true;await dialog.accept();
  });
  await page.getByRole("button",{name:"移除管理记录",exact:true}).click();
  await expect(page.getByRole("button",{name:"移除管理记录",exact:true})).toHaveCount(0);
  await expect(page.getByText(/已移除 1 条管理记录/)).toBeVisible();
  assert.equal(confirmed,true);assert.equal(await fs.readFile(path.join(source,"fixture.wav"),"utf8"),"synthetic-original");
  assert.equal((await fs.readdir(path.join(data,"root-removal-backups"))).length,1);
  assert.deepEqual(errors,[]);
  console.log("PASS: headless1280x800 preview/confirmation/removal, backup created, original untouched, no page errors");
} finally {
  await browser?.close();
  if(server.exitCode===null){const stopped=new Promise(r=>server.once("exit",r));server.kill("SIGTERM");await stopped;}
  await fs.rm(base,{recursive:true,force:true});
}
