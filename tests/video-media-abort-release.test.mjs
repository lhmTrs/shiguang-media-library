// 浏览器在服务端「打开视频文件」途中取消请求（拖进度条、切视频时很常见）：
// 句柄必须照样释放，否则 VideoMedia.close() 永远报 VIDEO_WORK_UNSETTLED，服务关不掉。
// 四个放视频的路由各测一次；全部用合成文件和假 store，不碰真实库或 4317。
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import http from 'node:http';import {once} from 'node:events';
import express from 'express';
import {VideoMedia} from '../server/storyboard-video/media.mjs';
import {storyboardVideoRouter} from '../server/storyboard-video/router.mjs';
import {projectVideoRouter} from '../server/project-videos/router.mjs';
import {projectRenderRouter} from '../server/project-renders.mjs';
import {fileIntakeRouter} from '../server/file-intake/router.mjs';

const sendMedia=async(req,res,_p,handle)=>{const st=await handle.stat();res.setHeader('Content-Length',st.size);res.setHeader('Content-Type','video/mp4');if(req.method==='HEAD'){res.end();return;}const s=handle.createReadStream({autoClose:false,start:0});s.on('error',()=>res.destroy());res.on('close',()=>s.destroy());s.pipe(res);};
const tick=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=2000){const end=Date.now()+ms;while(!fn()){if(Date.now()>end)return false;await tick(5);}return true;}

async function sample(t){const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sg-abort-release-')));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'合成.mp4');await fs.writeFile(file,Buffer.alloc(256*1024,7));return file;}

// 每个路由一份：mount(media, slowOpen) 返回 { app, url }。slowOpen 会在打开前停住，等测试放行。
const routes={
 storyboard:(media,open)=>{const store={media,open:(_p,_s)=>open()};return{app:express().use('/api/storyboard-video',storyboardVideoRouter(store,{sendMedia,picker:{close:async()=>{}}}).router),url:'/api/storyboard-video/projects/p1/sources/s1/media'};},
 projectVideo:(media,open)=>{const store={media,open:(_p,_s)=>open()};return{app:express().use('/api/project-videos',projectVideoRouter(store,{sendMedia})),url:'/api/project-videos/projects/p1/videos/s1/media'};},
 render:(media,open)=>{const store={catalog:{media},open:()=>open()};return{app:express().use('/api/projects/:projectId/timelines/:timelineId/render',projectRenderRouter(store,{sendMedia})),url:'/api/projects/p1/timelines/t1/render/media'};},
 intakeCandidate:(media,open)=>{const store={catalog:{media},generic:{openCandidate:()=>open()}};return{app:express().use('/api/file-intake',fileIntakeRouter(store,{},{sendMedia})),url:'/api/file-intake/media-imports/r1/candidates/c1/media'};},
};

async function serve(t,mount,file){
 const media=new VideoMedia();let started,go;const opening=new Promise(r=>{started=r;}),gate=new Promise(r=>{go=r;});let slow=true,opened=false;
 const open=async()=>{if(slow){started();await gate;}const o=await media.open({path:file});opened=true;return{...o,path:file};};
 const {app,url}=mount(media,open);const server=http.createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(r=>{server.closeAllConnections?.();server.close(r);}));
 return{media,url:`http://127.0.0.1:${server.address().port}${url}`,opening,go,fast:()=>{slow=false;},opened:()=>opened};
}

for(const [name,mount] of Object.entries(routes)){
 test(`${name}: 打开途中浏览器取消，句柄仍释放，关闭能结清`,async t=>{
  const file=await sample(t),s=await serve(t,mount,file);
  const req=http.get(s.url,res=>res.resume());req.on('error',()=>{});
  await s.opening;req.destroy();await tick(60);   // 服务端此时已收到断开，打开还没完成
  s.go();
  assert.ok(await until(s.opened),'打开没有完成');await tick(30);   // 先等句柄真的打开，再看它有没有被释放
  assert.ok(await until(()=>s.media.handles.size===0&&s.media.responses.size===0),`句柄未释放：handles=${s.media.handles.size} responses=${s.media.responses.size}`);
  await s.media.close();                            // 旧代码在这里抛 VIDEO_WORK_UNSETTLED
 });

 test(`${name}: 正常播放完，句柄释放（对照）`,async t=>{
  const file=await sample(t),s=await serve(t,mount,file);s.fast();
  const body=await new Promise((resolve,reject)=>http.get(s.url,res=>{let n=0;res.on('data',b=>{n+=b.length;});res.on('end',()=>resolve({status:res.statusCode,n}));}).on('error',reject));
  assert.equal(body.status,200);assert.equal(body.n,256*1024);
  assert.ok(await until(()=>s.media.handles.size===0),'正常播放后句柄未释放');await s.media.close();
 });
}

test('关闭进行中才打开完的请求：句柄释放，不留给关闭检查',async t=>{
 const file=await sample(t),s=await serve(t,routes.projectVideo,file);
 const req=http.get(s.url,res=>res.resume());req.on('error',()=>{});
 await s.opening;const closing=s.media.close().then(()=>'closed',e=>e.code);await tick(20);s.go();
 assert.equal(await closing,'closed');assert.equal(s.media.handles.size,0);req.destroy();
});
