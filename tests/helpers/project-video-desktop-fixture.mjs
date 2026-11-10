import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {Library} from '../../server/library.mjs';
import {Projects} from '../../server/projects.mjs';
import {ProjectAssets} from '../../server/project-assets/store.mjs';
import {StoryboardDatabase} from '../../server/storyboard/database.mjs';
import {createStoryboardVideo} from '../../server/storyboard-video/index.mjs';
import {ProjectVideos} from '../../server/project-videos/store.mjs';
import {syntheticSource} from './storyboard-fixture.mjs';

export const command='ffmpeg';
export const encode=(file,color='blue',duration=4)=>{
  const r=spawnSync(command,['-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i',`color=c=${color}:s=64x64:r=8:d=${duration}`,'-c:v','libx264','-pix_fmt','yuv420p','-threads','1',file]);
  assert.equal(r.status,0,r.stderr?.toString());
};
export async function fixture(t){
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sg-video-desktop-test-')));
  const lib=await new Library(path.join(dir,'data'),{directoryClassification:true}).init();lib.enqueue=()=>{};
  const projects=new Projects(lib).init(),assets=new ProjectAssets(lib).init(),storyboards=new StoryboardDatabase(lib,assets).init();
  const entry=createStoryboardVideo({lib,storyboards,command:'ffprobe'});
  const native={version:3,copies:[],reveals:[],async capabilities(){return {clipboard:{available:true},revealMany:{available:true}};},async clipboardVersion(){return this.version;},async copyFiles(paths,{expectedChangeCount}){if(expectedChangeCount!==this.version)throw Object.assign(Error('clipboard changed'),{code:'CLIPBOARD_CHANGED',status:409,effectUnknown:false});this.copies.push(paths);return {ack:'written',count:paths.length,changeCount:++this.version};},async revealFiles(paths){this.reveals.push(paths);return {ack:'dispatched',count:paths.length};},async close(){}};
  const trash=[];
  const catalog=new ProjectVideos(entry.store,{directory:path.join(dir,'owned','video'),desktopNative:native,trash:async file=>{const target=path.join(dir,'.Trash',randomUUID()+'.mp4');await fs.mkdir(path.dirname(target),{recursive:true});await fs.rename(file,target);trash.push(target);return target;}});
  const project=projects.save(null,{name:'后台视频合成项目'}),other=projects.save(null,{name:'另一个合成项目'});
  const file=path.join(dir,'fixture.mp4');encode(file);
  const f={dir,lib,projects,assets,storyboards,entry,catalog,native,trash,project,other,file,bytes:await fs.readFile(file)};
  t.after(async()=>{await catalog.close();await entry.close();assert.equal(entry.media.handles.size,0);assert.equal(entry.media.children.size,0);assert.equal(entry.media.closes.size,0);assert.equal(catalog.actionJournal.active.size,0);lib.db.close();await fs.rm(dir,{recursive:true,force:true});});
  return f;
}
export async function imported(f,name='owned-'+randomUUID()+'.mp4',folderId='root'){
  const requestId=randomUUID();await f.catalog.start(f.project.id,{requestId,fileName:name,folderId,bytes:f.bytes.length,title:'合成标题',notes:'需要保留的备注',prompt:{mode:'new',title:'原提示词',text:'需要保留的参考正文'}});
  const r=await f.catalog.upload(f.project.id,requestId,Readable.from([f.bytes]));assert.equal(r.status,'ready');return f.entry.store.source(f.project.id,r.videoId);
}
export async function finish(f,initial){
  if(['checking','dispatching','running'].includes(initial.status))await f.catalog.actionJournal.active.get(initial.requestId);
  return f.catalog.actionJournal.dto(f.catalog.actionJournal.row(f.project.id,initial.requestId));
}
export function initialize(f){
  const p=syntheticSource(),shot=p.scenes[0].shots[0];p.scenes[0].shots=Array.from({length:3},()=>({...structuredClone(shot),id:'s-'+randomUUID(),duration_ms:1000,dialogue:[]}));
  return f.storyboards.initialize(f.project.id,{source:p,request_id:randomUUID(),expected_revision:null});
}
export async function bind(f,source,shotIndexes=[0,1,2]){
  const st=await f.entry.store.state(f.project.id),inspection=await f.entry.store.inspect(f.project.id,[{sourceId:source.id}]);
  return f.entry.store.import(f.project.id,{requestId:randomUUID(),guards:{documentId:st.documentId,initializedAt:st.initializedAt,expectedStoryboardRevision:st.storyboardRevision,expectedPlanRevision:st.plan.revision,timingHash:st.timingHash},shotIds:shotIndexes.map(i=>st.shots[i].id),videos:[{token:inspection.items[0].token,inMs:0,outMs:source.durationMs}]});
}
export async function replaceBytes(f,source,{color='red',duration=4}={}){
  const file=path.join(f.dir,randomUUID()+'.mp4');encode(file,color,duration);await fs.writeFile(source.path,await fs.readFile(file));
}
export async function appendXmp(source){
  const payload=Buffer.from('informational xmp only'),id=Buffer.from('be7acfcb97a942e89c71999491e3afac','hex'),head=Buffer.alloc(8);head.writeUInt32BE(8+id.length+payload.length);head.write('uuid',4);await fs.appendFile(source.path,Buffer.concat([head,id,payload]));
}
