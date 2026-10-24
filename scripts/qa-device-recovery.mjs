// Disposable component fixture only: no app server, user database or cloud account.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "@playwright/test";

const project = fileURLToPath(new URL("..", import.meta.url));
const output = path.join(project, "collab/results/DEVICE-RECOVERY-UI-20261024");
await fs.mkdir(output, { recursive: true });
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {CloudWorkspace} from '/src/CloudWorkspace.tsx';
import {CloudLoginPage} from '/src/CloudAccount.tsx';
import {useCloudAuth} from '/src/cloud-auth.ts';
import '/src/style.css';import '/src/themes.css';
const deviceId='11111111-2222-4333-8444-555555555555';
const account={id:'account-fixture',username:'fixture-user',displayName:'隔离验收账户',state:'PENDING',securityVersion:0,createdAt:null,superAdmin:false};
const workspace=new URLSearchParams(location.search).has('workspace');
const noIdentity=new URLSearchParams(location.search).has('noIdentity');
const legacyBackend=new URLSearchParams(location.search).has('legacyBackend');
let statusFailure=new URLSearchParams(location.search).has('statusFailure');
let revoked=false,recovered=false;
let readFailure=new URLSearchParams(location.search).has('fail'),empty=false;
window.calls=[];
const request=async(route,body)=>{
  window.calls.push({route,hasPassword:!!body?.currentPassword});
  if(route==='/cloud-auth/status'){
    if(statusFailure)throw {code:'STORAGE_ERROR'};
    return {configured:!recovered,hasClientCertificate:!recovered,state:workspace?'logged-in':'logged-out',accountId:workspace?'owner-fixture':null,enrollment:{recoverySupported:legacyBackend?undefined:true,ready:true,deviceId:recovered||noIdentity?null:deviceId,activationPending:!recovered&&!noIdentity,lastSessionErrorCode:'INVALID_REQUEST'}};
  }
  if(route==='/cloud-auth/recover-device'){
    if(!revoked)throw {code:'DEVICE_NOT_REVOKED',status:409};
    recovered=true;return {recovered:true,state:await request('/cloud-auth/status')};
  }
  if(route==='/cloud-management/profile')return {me:{accountId:'owner-fixture',username:'admin',deviceId:'owner-device',superAdmin:true},capabilities:{superAdmin:true,systemPermissions:['account:read','account:create'],groups:[]},devices:[]};
  if(route.startsWith('/cloud-management/accounts?'))return {items:[account],total:1,limit:20,offset:0};
  if(route==='/cloud-management/accounts/account-fixture')return account;
  if(route.includes('/devices/')&&route.endsWith('/revoke')){revoked=true;return null;}
  if(route.includes('/devices?')){if(readFailure)throw {code:'INTERNAL',status:500};return {items:empty?[]:[{id:deviceId,name:'MacBook Pro · 剪辑工作站',state:revoked?'REVOKED':'PENDING',certificateExpiresAt:'2026-11-22T10:36:00Z',createdAt:'2026-10-23T10:36:00Z',lastSeenAt:null}],total:empty?0:1,limit:20,offset:0};}
  throw {code:'RESPONSE_INVALID'};
};
window.markRevoked=()=>{revoked=true;};
window.allowStatusRead=()=>{statusFailure=false;};
window.allowDeviceRead=()=>{readFailure=false;};window.emptyDevices=()=>{empty=true;};
function App(){const auth=useCloudAuth(request);return workspace
? React.createElement(CloudWorkspace,{auth,request,onBack:()=>{},onLogin:()=>{},onNotice:()=>{}})
: React.createElement(CloudLoginPage,{auth,onBack:()=>{},onAdvanced:()=>{}});}
createRoot(document.getElementById('root')).render(React.createElement(App));
`;
const server = await createServer({
  root: project,
  plugins: [{
    name: "device-recovery-fixture",
    resolveId(id) { if (id === "/recovery-fixture.tsx") return id; },
    load(id) { if (id === "/recovery-fixture.tsx") return fixture; },
    configureServer(instance) {
      instance.middlewares.use((req, res, next) => {
        let pathname;
        try { pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname); } catch { res.statusCode = 400; res.end(); return; }
        const allowed = ["/recovery-fixture", "/recovery-fixture.tsx", "/@vite/client"].includes(pathname)
          || pathname.startsWith("/src/") || pathname.startsWith("/node_modules/");
        if (!allowed || pathname.includes("..") || pathname.includes("%") || pathname.includes("\\")) { res.statusCode = 404; res.end(); return; }
        next();
      });
    },
  }],
  server: { host: "127.0.0.1", port: 0 }, appType: "custom",
});
server.middlewares.use(async (req, res, next) => {
  if (!req.url?.startsWith("/recovery-fixture?")) return next();
  res.setHeader("Content-Type", "text/html");
  res.end(await server.transformIndexHtml("/recovery-fixture", '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/recovery-fixture.tsx"></script>'));
});
let browser;
try {
  await server.listen();
  if (process.argv.includes("--preview")) {
    console.log(`DEVICE_RECOVERY_PREVIEW http://127.0.0.1:${server.httpServer.address().port}/recovery-fixture?workspace`);
    await new Promise(resolve => { process.once("SIGTERM", resolve); process.once("SIGINT", resolve); });
    process.exitCode = 0;
  } else {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const base = `http://127.0.0.1:${server.httpServer.address().port}/recovery-fixture`;
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 375, height: 900 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${base}?workspace`);
    await page.getByRole("button", { name: "账户管理", exact: true }).click();
    await page.getByRole("button", { name: "设备管理", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "账户设备管理" });
    await panel.getByText("共 1 台设备", { exact: true }).waitFor();
    assert.equal(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, "drawer overflow");
    await page.screenshot({ path: path.join(output, `devices-${viewport.width}.png`), fullPage: true });
    await panel.getByRole("button", { name: "撤销设备", exact: true }).click();
    await panel.getByLabel("撤销设备的管理员密码").fill("synthetic-owner-password");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "workspace overflow");
    await page.screenshot({ path: path.join(output, `admin-${viewport.width}.png`), fullPage: true });
    await panel.getByRole("button", { name: "确认撤销", exact: true }).click();
    await panel.getByText(/设备已撤销，账户及素材已保留/).waitFor();
    assert.equal(await panel.getByLabel("撤销设备的管理员密码").count(), 0);
    await page.goto(`${base}?login`);
    await page.getByRole("heading", { name: "开通本机" }).waitFor();
    await page.screenshot({ path: path.join(output, `login-${viewport.width}.png`), fullPage: true });
    await page.locator("summary").filter({ hasText: "设备与开通恢复" }).click();
    const recover = page.getByRole("button", { name: "重新开通本机", exact: true });
    assert.equal(await recover.isDisabled(), true);
    await page.getByRole("checkbox").check();
    await recover.click();
    await page.getByText(/云端尚未确认本机设备已撤销/).waitFor();
    await page.evaluate(() => window.markRevoked());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "login overflow");
    await page.screenshot({ path: path.join(output, `client-${viewport.width}.png`), fullPage: true });
    await recover.click();
    await page.getByText(/旧设备材料已安全备份/).waitFor();
    assert.equal(await page.getByRole("checkbox").count(), 0);
    for (const [query, diagnostic] of [
      ["noIdentity=1", "未读取到本机已登记的设备 ID"],
      ["legacyBackend=1", "当前后台未声明支持设备恢复"],
      ["statusFailure=1", "本机设备状态读取失败"],
    ]) {
      await page.goto(`${base}?login&${query}`);
      await page.locator("summary").filter({ hasText: "设备与开通恢复" }).click();
      await page.getByText(diagnostic, { exact: false }).waitFor();
      assert.equal(await page.getByRole("button", { name: "重新开通本机", exact: true }).count(), 0);
      assert.equal(await page.evaluate(() => window.calls.some(call => call.route === '/cloud-auth/recover-device')), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await page.screenshot({ path: path.join(output, `${query.split('=')[0]}-${viewport.width}.png`), fullPage: true });
      if (query.startsWith("statusFailure")) {
        await page.evaluate(() => window.allowStatusRead());
        await page.getByRole("button", { name: "重新读取设备状态", exact: true }).click();
        await page.getByRole("button", { name: "重新开通本机", exact: true }).waitFor();
      }
    }
    await page.goto(`${base}?workspace&fail=1`);
    await page.getByRole("button", { name: "账户管理", exact: true }).click();
    await page.getByRole("button", { name: "设备管理", exact: true }).click();
    await panel.getByRole("heading", { name: "设备列表暂不可用" }).waitFor();
    assert.equal(await panel.getByText(/共 0/).count(), 0);
    assert.equal(await panel.getByText("没有匹配的设备", { exact: true }).count(), 0);
    await page.screenshot({ path: path.join(output, `read-error-${viewport.width}.png`), fullPage: true });
    await page.evaluate(() => window.allowDeviceRead());
    await panel.getByRole("button", { name: "重新读取", exact: true }).click();
    await panel.getByText("共 1 台设备", { exact: true }).waitFor();
    await page.evaluate(() => window.emptyDevices());
    await panel.getByRole("button", { name: "刷新设备列表", exact: true }).click();
    await panel.getByRole("heading", { name: "没有匹配的设备" }).waitFor();
    await panel.getByText("共 0 台设备", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("dialog").count(), 0);
    await page.getByRole("button", { name: "设备管理", exact: true }).click();
    await panel.getByRole("heading", { name: "没有匹配的设备" }).waitFor();
    await panel.getByRole("button", { name: "关闭设备管理", exact: true }).click();
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log("PASS DEVICE_RECOVERY_BROWSER_DESKTOP_AND_MOBILE");
  }
} finally {
  await browser?.close();
  await server.close();
}
