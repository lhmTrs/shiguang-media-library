// Disposable browser harness; no author library, real cloud, credentials or server restart.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const evidence=path.resolve(process.argv[2] || path.join(root,'collab/results/CLOUD-UPLOAD-APPROVAL-SETTINGS-20261025'));
await fs.mkdir(evidence,{recursive:true});
const temp=await fs.mkdtemp(path.join(root,'collab/results/approval-ui-temp-'));
let server,browser;
try {
  await fs.writeFile(path.join(temp,'index.html'),'<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/main.tsx"></script>');
  await fs.writeFile(path.join(temp,'main.tsx'),`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {CloudWorkspace} from ${JSON.stringify(path.join(root,'src/CloudWorkspace.tsx'))};
import ${JSON.stringify(path.join(root,'src/style.css'))};
import ${JSON.stringify(path.join(root,'src/themes.css'))};
let owner=new URLSearchParams(location.search).get('owner')!=='0';
let current={thresholdMb:100,thresholdBytes:100000000,version:0,configured:false};
const harness=window.settingsHarness={calls:[],conflict:false,deny:false};
const request=async (route,body,method)=>{
 harness.calls.push({route,body,method});
 if(route==='/cloud-management/profile')return {me:{accountId:'synthetic',username:'synthetic',displayName:'测试账户',deviceId:'test',sessionId:'test',superAdmin:owner},capabilities:{superAdmin:owner,systemPermissions:[],groups:[]},devices:[]};
 if(route==='/cloud-management/upload-approval-settings'){
   if(!method)return {...current};
   if(harness.deny){owner=false;throw {code:'FORBIDDEN',status:403};}
   if(harness.conflict){harness.conflict=false;current={thresholdMb:150,thresholdBytes:150000000,version:current.version+1,configured:true};throw {code:'VERSION_CONFLICT',status:409};}
   if(method!=='PUT'||!Number.isInteger(body.thresholdMb)||body.expectedVersion!==current.version)throw {code:'INVALID_REQUEST',status:400};
   current={thresholdMb:body.thresholdMb,thresholdBytes:body.thresholdMb*1000000,version:current.version+1,configured:true};return {...current};
 }
 throw new Error('Unexpected harness route');
};
createRoot(document.getElementById('root')).render(<CloudWorkspace auth={{view:{state:'logged-in',accountId:'synthetic'},loading:false,readStatus:async()=>{}}} request={request} onBack={()=>{}} onLogin={()=>{}} onNotice={()=>{}}/>);
`);
  server=await createServer({configFile:false,root:temp,esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0,fs:{allow:[root]}},logLevel:'error'});await server.listen();
  const url=server.resolvedUrls.local[0];
  browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const page=await browser.newPage({viewport:{width:1280,height:850}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const checks=[];
  await page.goto(url+'?owner=0');await expect(page.getByText('普通账户',{exact:false})).toBeVisible();await expect(page.getByRole('button',{name:'上传审批设置',exact:true})).toHaveCount(0);checks.push('non-owner entry absent');
  await page.goto(url);await page.getByRole('button',{name:'上传审批设置',exact:true}).click();
  const input=page.getByRole('spinbutton',{name:'免审阈值（MB）'});await expect(input).toHaveValue('100');await expect(page.getByText('仅超级管理员可修改。',{exact:false})).toBeVisible();
  await input.fill('200');await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.getByRole('status')).toContainText('已保存为 200 MB，仅对新上传申请生效');
  const writes=await page.evaluate(()=>window.settingsHarness.calls.filter(c=>c.method));expect(writes).toEqual([{route:'/cloud-management/upload-approval-settings',body:{thresholdMb:200,expectedVersion:0},method:'PUT'}]);checks.push('save fixed PUT body and explicit success');
  await page.screenshot({path:path.join(evidence,'settings-desktop.png'),fullPage:false});
  await page.evaluate(()=>window.settingsHarness.conflict=true);await input.fill('300');await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.getByRole('alert')).toContainText('请重新读取');await expect(page.getByRole('button',{name:'保存',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'重新读取',exact:true}).click();await expect(input).toHaveValue('150');await expect(page.getByRole('button',{name:'保存',exact:true})).toBeEnabled();checks.push('409 blocks overwrite until explicit reload');
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(evidence,'settings-mobile.png'),fullPage:false});
  await page.evaluate(()=>window.settingsHarness.deny=true);await input.fill('160');await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.getByRole('button',{name:'上传审批设置',exact:true})).toHaveCount(0);checks.push('403 reloads capabilities and removes owner view');
  expect(errors).toEqual([]);await fs.writeFile(path.join(evidence,'ui-results.json'),JSON.stringify({passed:true,checks,pageErrors:errors},null,2));console.log(JSON.stringify({passed:true,checks}));
} finally {await browser?.close();await server?.close();await fs.rm(temp,{recursive:true,force:true});}
