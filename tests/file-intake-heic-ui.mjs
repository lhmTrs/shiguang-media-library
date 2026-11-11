// Native HEIC -> original App route -> Chromium pixels, using owned SQLite only.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {Receipts} from '../server/file-intake/files.mjs';
if(process.platform!=='darwin')throw Error('This native HEIC check requires macOS sips');
const root=path.resolve(import.meta.dirname,'..'),run=promisify(execFile),pause=ms=>new Promise(r=>setTimeout(r,ms));
const owned=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sg-heic-app-'))),dataDir=path.join(owned,'data');
const evidence=path.resolve(process.env.HEIC_PREVIEW_EVIDENCE||path.join(owned,'evidence'));await fs.mkdir(evidence,{recursive:true});
const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));assert.notEqual(port,4317);
const origin='http://127.0.0.1:'+port,hash=b=>createHash('sha256').update(b).digest('hex');
let child,exited,exit,output='',browser,ctx,cookie='',token='',passed=false;const checks=[],errors=[];
async function ready(){const end=Date.now()+30000;while(Date.now()<end){if(exit)throw Error('Owned App exited before ready');try{const r=await fetch(origin+'/api/session');if(r.ok){const s=await r.json();cookie=r.headers.get('set-cookie').split(';')[0];token=s.token;const record=JSON.parse(await fs.readFile(path.join(dataDir,'server.json'),'utf8'));assert.equal(record.pid,child.pid);return;}}catch{}await pause(30);}throw Error('Owned App ready timeout');}
async function stop(){if(!child||exit)return;child.kill('SIGTERM');let timer;try{await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('OWNED_APP_CLOSE_UNKNOWN; no forced signal attempted')),20000);})]);}finally{clearTimeout(timer);}assert.deepEqual(exit,{code:0,signal:null});assert.match(output,/APPLICATION_CLOSED_KNOWN/);}
async function api(url,body){const r=await fetch(origin+'/api'+url,{method:body?'POST':'GET',headers:{cookie,...(body?{'content-type':'application/json','x-local-token':token}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});const value=await r.json();if(!r.ok)throw Object.assign(Error(value.error),{status:r.status});return value;}
async function pixels(page,file){const img=page.getByRole('img',{name:path.basename(file),exact:true});await expect(img).toBeVisible();await expect.poll(()=>img.evaluate(node=>node.complete&&node.naturalWidth>0)).toBe(true);const value=await img.evaluate(node=>{const c=document.createElement('canvas');c.width=c.height=1;const x=c.getContext('2d');x.drawImage(node,0,0,1,1);const box=node.getBoundingClientRect();return{rgb:[...x.getImageData(0,0,1,1).data],natural:[node.naturalWidth,node.naturalHeight],shown:[Math.round(box.width),Math.round(box.height)]};});assert.ok(value.rgb[1]>value.rgb[0]+70&&value.rgb[1]>value.rgb[2]+30,JSON.stringify(value));assert.ok(value.shown[0]>=40&&value.shown[1]>=30,JSON.stringify(value));return value;}
try{
  const ppm=path.join(owned,'synthetic.ppm'),source=path.join(owned,'owned.HEIC'),png=path.join(owned,'owned.png'),jpg=path.join(owned,'owned.jpg'),bad=path.join(owned,'broken.heic');
  const rgb=Buffer.alloc(96*64*3);for(let i=0;i<rgb.length;i+=3){rgb[i]=30;rgb[i+1]=150;rgb[i+2]=80;}
  await fs.writeFile(ppm,Buffer.concat([Buffer.from('P6\n96 64\n255\n'),rgb]));
  for(const [format,file]of [['heic',source],['png',png],['jpeg',jpg]])await run('/usr/bin/sips',['-s','format',format,ppm,'--out',file]);await fs.writeFile(bad,'owned invalid HEIC');
  const sourceHash=hash(await fs.readFile(source));
  child=spawn(process.execPath,['server/index.mjs'],{cwd:root,env:{...process.env,NODE_ENV:'production',PORT:String(port),MEDIA_DATA_DIR:dataDir,MEDIA_PERSONAL_ITEM_DIR:path.join(owned,'personal_item'),MEDIA_SKIP_IMPORT:'1',MEDIA_SKIP_RECONCILE:'1',MEDIA_NO_WATCH:'1',MEDIA_CODEX_AUTOCONNECT:'0',CODEX_HOME:path.join(owned,'empty-codex'),CODEX_BIN:path.join(owned,'no-codex')},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);exited=new Promise(resolve=>child.once('exit',(code,signal)=>{exit={code,signal};resolve(exit);}));
  await ready();const receipts=await new Receipts(dataDir).init();
  browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});ctx=await browser.newContext();
  await ctx.addCookies([{name:cookie.split('=')[0],value:cookie.split('=')[1],url:origin}]);
  const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
  const h=await receipts.handoff([source,png,jpg]);await page.goto(origin+'/#/file-intake/'+h.id);
  await expect(page.getByRole('heading',{name:'收纳素材到拾光',exact:true})).toBeVisible();
  for(const file of [source,png,jpg])checks.push({name:path.basename(file),decoded:await pixels(page,file)});
  const url='/api/file-intake/handoffs/'+h.id+'/files/'+h.files[0].id+'/preview';
  const response=await fetch(origin+url,{headers:{cookie}});assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/^image\/jpeg/);await response.arrayBuffer();
  await page.screenshot({path:path.join(evidence,'success.png'),fullPage:true});
  // A transient response failure must offer retry without losing the draft.
  const retry=await receipts.handoff([source]),retryPage=await ctx.newPage();let injected=0;
  await retryPage.route('**/api/file-intake/handoffs/*/files/*/preview*',async route=>{if(injected++===0)await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'owned transient outage'})});else await route.continue();});
  await retryPage.goto(origin+'/#/file-intake/'+retry.id);const alert=retryPage.getByRole('alert').filter({hasText:'图片预览未能显示'});await expect(alert).toBeVisible();
  await retryPage.locator('[data-file-id="'+retry.files[0].id+'"]').click();const panel=retryPage.getByRole('dialog',{name:'收纳设置 '+path.basename(source),exact:true});await panel.getByText('修改导入后的文件名',{exact:true}).click();const filename=panel.getByLabel('副本名称 '+retry.files[0].id,{exact:true});await filename.fill('preserved.HEIC');await panel.getByRole('button',{name:'完成',exact:true}).click();
  await retryPage.screenshot({path:path.join(evidence,'failure-retry.png'),fullPage:true});await alert.getByRole('button',{name:'重新读取',exact:true}).click();await expect(retryPage.locator('.fi-single')).toContainText('preserved.HEIC');const restored=retryPage.getByRole('img',{name:path.basename(source),exact:true});await expect(restored).toBeVisible();await expect.poll(()=>restored.evaluate(node=>node.complete&&node.naturalWidth>0)).toBe(true);checks.push({name:'transient failure is visible; retry decodes JPEG and preserves filename',passed:true});
  const broken=await receipts.handoff([bad]),badPage=await ctx.newPage();await badPage.goto(origin+'/#/file-intake/'+broken.id);await expect(badPage.getByRole('alert').filter({hasText:'图片预览未能显示'})).toBeVisible();await expect(badPage.getByRole('img',{name:path.basename(bad),exact:true})).toHaveCount(0);checks.push({name:'real invalid HEIC surfaces readable failure without a broken image',passed:true});
  // Copy still carries the HEIC source, never the JPEG used for preview.
  await expect(page.locator('.fi-confirm-button')).toBeEnabled();const confirmed=page.waitForResponse(r=>r.url().endsWith('/'+h.id+'/confirm')&&r.request().method()==='POST');await page.locator('.fi-confirm-button').click();const accepted=await (await confirmed).json();assert.ok(accepted.id);
  let batch;const end=Date.now()+15000;while(Date.now()<end){batch=await api('/file-intake/batches/'+accepted.id);if(batch.status==='completed')break;await pause(30);}
  assert.equal(batch?.status,'completed');assert.ok(batch.items.every(i=>i.status==='ready'));
  const item=batch.items.find(i=>i.name===path.basename(source));assert.ok(item,'HEIC receipt item');const asset=await api('/assets/'+item.assetId);assert.equal(path.extname(asset.path).toLowerCase(),'.heic');assert.equal(hash(await fs.readFile(asset.path)),sourceHash);assert.equal(hash(await fs.readFile(source)),sourceHash);
  checks.push({name:'actual confirmed copy retains HEIC bytes and source hash',passed:true});
  assert.deepEqual(errors,[]);await browser.close();browser=null;await stop();passed=true;
}finally{
  await browser?.close();let closeError;try{await stop();}catch(e){closeError=e.message;}
  await fs.writeFile(path.join(evidence,'app.log'),output);await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify({passed:passed&&!closeError,checks,owned,port,exit,applicationClosedKnown:/APPLICATION_CLOSED_KNOWN/.test(output),closeError},null,2));if(closeError)throw Error(closeError);
}
console.log(JSON.stringify({passed,evidence,checks}));
