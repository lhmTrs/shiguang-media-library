// 真实本地服务 + 合成数据：反复「请求视频、刚发出就取消」（模拟拖进度条、快速切视频），
// 然后像发布时一样发 SIGTERM。必须正常关闭（APPLICATION_CLOSED_KNOWN 并退出），
// 不能再报 VIDEO_WORK_UNSETTLED 卡在半关闭。不碰真实库、4317 或云端。
// 用法：node tests/video-abort-shutdown-real.mjs   （需要 ffmpeg）
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import net from 'node:net';import http from 'node:http';import crypto from 'node:crypto';import assert from 'node:assert/strict';import {spawn,execFileSync} from 'node:child_process';

const root=path.resolve(import.meta.dirname,'..');
const temp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'video-abort-shutdown-')));
const file=path.join(temp,'合成.mp4');
execFileSync('ffmpeg',['-loglevel','error','-f','lavfi','-i','testsrc=size=320x180:rate=25:duration=20','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',file]);
const bytes=await fs.readFile(file);
const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));const origin='http://127.0.0.1:'+port;
let logs='';
const child=spawn(process.execPath,['server/index.mjs'],{cwd:root,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),NODE_ENV:'production',MEDIA_CONTAINER:'0',MEDIA_DATA_DIR:path.join(temp,'data'),MEDIA_PERSONAL_ITEM_DIR:path.join(temp,'personal'),CODEX_HOME:path.join(temp,'no-codex'),MEDIA_SKIP_IMPORT:'1',MEDIA_SKIP_RECONCILE:'1',MEDIA_NO_WATCH:'1',MEDIA_CODEX_AUTOCONNECT:'0',SHIGUANG_AUDIO_ANALYSIS:'0',MEDIA_DISABLE_DESKTOP_NATIVE:'1'},stdio:['ignore','pipe','pipe']});
child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);const exited=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));
const tick=ms=>new Promise(r=>setTimeout(r,ms));
let cookie,token;
async function api(p,body,method,raw){const r=await fetch(origin+'/api'+p,{method:method??(body?'POST':'GET'),headers:{cookie,origin,'x-local-token':token,'content-type':raw?'application/octet-stream':'application/json'},...(body?{body:raw?body:JSON.stringify(body)}:{})});const d=await r.json();if(!r.ok)throw Error(p+' '+r.status+' '+JSON.stringify(d).slice(0,300));return d;}
function abortedGet(url,afterMs){return new Promise(resolve=>{const req=http.get(url,{headers:{cookie,origin,'x-local-token':token,range:'bytes=0-'}},res=>{res.resume();res.on('close',resolve);});req.on('error',()=>resolve());req.on('close',resolve);setTimeout(()=>req.destroy(),afterMs);});}

let ok=false;
try{
 const end=Date.now()+25000;while(!logs.includes(origin)){if(Date.now()>end)throw Error('服务没起来：'+logs.slice(-500));await tick(50);}
 const s=await fetch(origin+'/api/session');cookie=s.headers.get('set-cookie').split(';')[0];token=(await s.json()).token;
 const project=await api('/projects',{name:'合成取消测试',software:'resolve'});
 const requestId=crypto.randomUUID();
 await api(`/project-videos/projects/${project.id}/imports`,{requestId,fileName:'合成.mp4',folderId:'root',bytes:bytes.length,prompt:{mode:'none'}});
 const done=await api(`/project-videos/projects/${project.id}/imports/${requestId}/content`,bytes,'PUT',true);
 assert.equal(done.status,'ready',JSON.stringify(done).slice(0,300));
 const list=await api(`/project-videos/projects/${project.id}?folderId=all`);
 const video=(list.videos||list.items||[])[0];const sourceId=video?.sourceId||video?.id;assert.ok(sourceId,'没拿到视频编号：'+JSON.stringify(list).slice(0,300));
 const url=`${origin}/api/project-videos/projects/${project.id}/videos/${sourceId}/media`;
 // 先确认能正常播放
 const full=await fetch(url,{headers:{cookie,origin,'x-local-token':token}});assert.equal(full.status,200);assert.equal((await full.arrayBuffer()).byteLength,bytes.length);
 // 反复「刚发出就取消」：取消时机散布在 0–6ms，覆盖「服务端还在打开文件」那一小段
 for(let i=0;i<120;i++)await abortedGet(url,i%7);
 await tick(300);
 const fds=(()=>{try{return execFileSync('lsof',['-p',String(child.pid)],{encoding:'utf8'}).split('\n').filter(l=>l.includes(path.join(temp,'personal'))&&/\.(mp4|mov|m4v)\b/i.test(l)).length;}catch{return -1;}})();
 console.log('取消后服务仍打开的视频文件数：'+fds);
 child.kill('SIGTERM');
 const result=await Promise.race([exited,tick(40000).then(()=>'timeout')]);
 const tail=logs.split('\n').filter(l=>/_UNSETTLED|APPLICATION_CLOSED_KNOWN|CLOSE_UNKNOWN/.test(l));
 console.log('关闭日志：'+JSON.stringify(tail));
 assert.notEqual(result,'timeout','SIGTERM 后 40 秒仍未退出（半关闭）');
 assert.ok(logs.includes('APPLICATION_CLOSED_KNOWN'),'没有正常关闭：'+tail.join(' | '));
 assert.ok(!logs.includes('VIDEO_WORK_UNSETTLED'),'仍报 VIDEO_WORK_UNSETTLED');
 assert.equal(fds,0,'取消请求后仍有视频文件没关');
 ok=true;console.log('PASS 取消视频请求 120 次后，SIGTERM 正常关闭');
}finally{
 if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}   // 只清理本测试自己起的合成服务
 await fs.rm(temp,{recursive:true,force:true});
 if(!ok)process.exitCode=1;
}
