import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Library} from '../../server/library.mjs';
import {Projects} from '../../server/projects.mjs';
import {ProjectAssets} from '../../server/project-assets/store.mjs';
import {StoryboardDatabase} from '../../server/storyboard/database.mjs';
import {createStoryboardVideo} from '../../server/storyboard-video/index.mjs';
import {ProjectVideos} from '../../server/project-videos/store.mjs';
const exec=promisify(execFile);
export const uid=randomUUID;
export async function fixture(t){
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sg-render-v1-'))),lib=await new Library(path.join(dir,'data')).init();lib.enqueue=()=>{};
 const projects=new Projects(lib).init(),assets=new ProjectAssets(lib).init(),storyboards=new StoryboardDatabase(lib,assets).init(),entry=createStoryboardVideo({lib,storyboards});
 const trash=async source=>{const dest=path.join(dir,'own-trash',uid(),path.basename(source));await fs.mkdir(path.dirname(dest),{recursive:true});await fs.rename(source,dest);return dest;};
 const catalog=new ProjectVideos(entry.store,{directory:path.join(dir,'personal_item','video'),trash}),project=projects.save(null,{name:'合成项目'}),other=projects.save(null,{name:'另一合成项目'});
 const timelineId=uid(),timelineRevision=uid();lib.db.prepare('INSERT INTO project_timelines VALUES(?,?,?,?,?,?,?)').run(timelineId,project.id,'合成时间线',JSON.stringify({fps:25,duration:2,startTimecode:null,refs:[],warnings:['合成警告']}),timelineRevision,uid(),Date.now());
 const f={dir,lib,projects,assets,storyboards,entry,catalog,project,other,timelineId,timelineRevision,renders:projects.renders};
 let closed=false;f.close=async()=>{if(closed)return;await catalog.close();await entry.close();for(const key of ['children','exits','handles','responses','work','closes'])assert.equal(entry.media[key].size,0,key);assert.equal(entry.media.probes,0);lib.db.close();closed=true;};t.after(f.close);
 const file=path.join(dir,'synthetic.mp4');await exec('ffmpeg',['-v','error','-nostdin','-f','lavfi','-i','color=c=blue:s=64x48:r=8:d=2','-c:v','libx264','-threads','1','-pix_fmt','yuv420p',file]);f.bytes=await fs.readFile(file);f.file=file;
 return f;
}
export async function imported(f,name='clip.mp4',folderId='root'){
 const requestId=uid();await f.catalog.start(f.project.id,{requestId,fileName:name,folderId,bytes:f.bytes.length,prompt:{mode:'none'}});
 const r=await f.catalog.upload(f.project.id,requestId,Readable.from([f.bytes]));assert.equal(r.status,'ready',r.error);return f.entry.store.source(f.project.id,r.videoId);
}
export const folder=(f,name,parentId='root')=>f.catalog.folders.create(f.project.id,{requestId:uid(),name,parentId});
export async function settled(f,result){
 if(['checking','running'].includes(result.status)){await f.catalog.usageJournal.active.get(result.requestId);result=result.timelineId?f.renders.request(f.project.id,result.timelineId,result.requestId):f.catalog.usageJournal.dto(f.catalog.usageJournal.row(f.project.id,result.requestId));}
 return result;
}
export function linkInput(f,source,extra={}){return{requestId:uid(),sourceId:source.id,offset:0,expectedRevision:f.renders.revision(f.renders.row(f.project.id,f.timelineId)),expectedSourceRevision:f.catalog.row(f.project.id,source.id).revision,expectedTimelineRevision:f.timelineRevision,...extra};}
export async function link(f,source,extra={}){const r=await settled(f,await f.renders.save(f.project.id,f.timelineId,linkInput(f,source,extra)));assert.equal(r.status,'completed',JSON.stringify(r));return r;}
export async function operation(f,body){const plan=await f.catalog.fileOperations.preview(f.project.id,{requestId:uid(),...body});assert.equal(plan.ready,true);await f.catalog.fileOperations.execute(f.project.id,{requestId:plan.requestId,previewHash:plan.previewHash,confirmUnbind:true,confirmedUnbindShotIds:plan.affectedShots.map(s=>s.id)});await f.catalog.queue;return f.catalog.fileOperations.row(f.project.id,plan.requestId);}
