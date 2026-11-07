import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "vite";
import { chromium } from "@playwright/test";

const out = await fs.mkdtemp(path.join(os.tmpdir(), "tag-ui-evidence-"));
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><body><div id="root" class="cloud-workspace" style="padding:20px"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {CloudTagsSync} from '/src/CloudTagsSync.tsx';
import '/src/style.css';
import '/src/themes.css';
window.__calls=[];
let me={authorId:'self',revision:0,policyVersion:0,visibility:'PRIVATE',count:0};
const cached={sources:[{authorId:'self',own:true,items:[{sha256:'a'.repeat(64),bytes:123,tags:['自己的标签']}]},{authorId:'alice',own:false,items:[{sha256:'a'.repeat(64),bytes:123,tags:['组员标签']}] }]};
const request=async(url,body,method)=>{
 window.__calls.push({url,body,method});
 if(url==='/cloud-tags/me')return me;
 if(url.startsWith('/cloud-tags/cache'))return {sources:[]};
 if(url==='/cloud-tags/policy'){me={...me,visibility:body.visibility,policyVersion:me.policyVersion+1};return me;}
 if(url==='/cloud-tags/sync')return {...cached,deferred:[]};
 if(url.startsWith('/cloud-tags/candidates'))return [{id:'synthetic',name:'合成音效.wav',tags:['自己的标签']}];
 if(url==='/cloud-tags/publish'){me={...me,revision:me.revision+1};return me;}
 if(url.startsWith('/cloud-management/groups/'))return [{accountId:'alice',displayName:'合成组员',state:'ACTIVE',accountState:'ACTIVE'}];
 throw Error('unexpected route');
};
createRoot(document.getElementById('root')).render(React.createElement(CloudTagsSync,{request,accountId:'self',groups:[{groupId:'synthetic-group',name:'测试小组',canReadShared:true}]}));
</script></body></html>`;
const server = await createServer({ configFile: false, server: { host: "127.0.0.1", port: 0, hmr: false }, plugins: [{ name: "tag-only-test-page", configureServer(s) {
  s.middlewares.use("/__tag-preview", async (req,res,next) => {
    if (req.method !== "GET") return next();
    res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(await s.transformIndexHtml("/__tag-preview",html));
  });
} }] });
let browser;
try {
  await server.listen();
  const address=server.httpServer.address(), url=`http://127.0.0.1:${address.port}/__tag-preview`;
  browser=await chromium.launch({headless:true,channel:"chrome"});
  const page=await browser.newPage({viewport:{width:1280,height:800}}), errors=[];
  page.on("pageerror",e=>errors.push(e.message));
  await page.goto(url);
  await page.getByRole("button",{name:"同步",exact:true}).waitFor();
  await page.getByRole("button",{name:"同步",exact:true}).click();
  await page.getByRole("status").filter({hasText:"同步完成"}).waitFor();
  assert.equal(await page.getByRole("cell",{name:"自己的标签",exact:true}).count(),1);
  assert.equal(await page.getByRole("cell",{name:"组员标签",exact:true}).count(),1);
  await page.getByLabel("标签查看范围").selectOption("MEMBER");
  await page.getByLabel("标签小组").selectOption("synthetic-group");
  await page.getByLabel("指定成员").selectOption("alice");
  await page.getByRole("button",{name:"同步",exact:true}).click();
  await page.getByRole("status").filter({hasText:"同步完成"}).waitFor();
  await page.getByLabel("查找本地音频").fill("合成");
  await page.getByRole("button",{name:"查找",exact:true}).click();
  await page.getByLabel("待同步素材").selectOption("synthetic");
  await page.getByRole("button",{name:"同步此素材标签",exact:true}).click();
  await page.getByText("标签版本 1",{exact:false}).waitFor();
  await page.screenshot({path:path.join(out,"desktop.png"),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:path.join(out,"mobile.png"),fullPage:true});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);
  assert.equal(overflow,false);assert.deepEqual(errors,[]);
  const calls=await page.evaluate(()=>window.__calls);
  assert.ok(calls.some(c=>c.url==="/cloud-tags/sync"&&c.body.memberId==="alice"));
  assert.ok(calls.some(c=>c.url==="/cloud-tags/publish"&&c.body.assetId==="synthetic"));
  assert.ok(calls.every(c=>!c.url.includes("cloud-audio")&&!c.url.includes("cloud-upload")));
  console.log(JSON.stringify({scope:"UI fixture only, not real cloud/MySQL/Windows",url,screenshots:out,calls:calls.length,overflow,pageErrors:errors}));
} finally { await browser?.close(); await server.close(); }
