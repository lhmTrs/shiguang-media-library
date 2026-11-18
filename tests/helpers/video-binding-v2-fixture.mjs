import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {Library} from '../../server/library.mjs';
import {Projects} from '../../server/projects.mjs';
import {ProjectAssets} from '../../server/project-assets/store.mjs';
import {StoryboardDatabase} from '../../server/storyboard/database.mjs';
import {createStoryboardVideo} from '../../server/storyboard-video/index.mjs';
import {ProjectVideos} from '../../server/project-videos/store.mjs';
import {syntheticSource} from './storyboard-fixture.mjs';
export async function videoV2Fixture(t){
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'video-binding-v2-'))),lib=await new Library(path.join(dir,'data')).init();lib.enqueue=()=>{};
 const projects=new Projects(lib).init(),assets=new ProjectAssets(lib).init(),board=new StoryboardDatabase(lib,assets).init(),entry=createStoryboardVideo({lib,storyboards:board,instanceId:'synthetic-instance'}),catalog=new ProjectVideos(entry.store,{directory:path.join(dir,'personal_item','video')}),v2=entry.bindingV2;
 const a=projects.save(null,{name:'合成来源集'}),b=projects.save(null,{name:'合成目标集'});
 t.after(async()=>{await catalog.close();await entry.close();if(entry.media.handles.size||entry.media.children.size)throw Error('owned resources not settled');lib.db.close();await fs.rm(dir,{recursive:true,force:true});});
 const file=path.join(dir,'synthetic.mp4'),command=spawnSync('/opt/homebrew/bin/ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=green:s=96x64:r=8:d=4','-c:v','libx264','-pix_fmt','yuv420p','-threads','1',file]);if(command.status!==0)throw Error('synthetic ffmpeg fixture failed');const bytes=await fs.readFile(file);
 const initialize=(projectId=a.id)=>{const p=syntheticSource(),shot=p.scenes[0].shots[0];p.scenes[0].shots=Array.from({length:3},(_,i)=>({...structuredClone(shot),id:'shot_'+i,dialogue:[],duration_ms:1000}));p.segments[0].start_shot_id='shot_0';return board.initialize(projectId,{source:p,request_id:randomUUID(),expected_revision:board.head(projectId)?.revision??null});};
 const imported=async(extra={})=>{const requestId=randomUUID();await catalog.start(a.id,{requestId,fileName:randomUUID()+'.mp4',bytes:bytes.length,prompt:{mode:'none'},...extra});return catalog.upload(a.id,requestId,Readable.from([bytes]));};
 const bind=async(videoId,ids=['shot_0','shot_1'],targetProjectId=a.id)=>{const view=board.read(targetProjectId),before=v2.sourceBinding(a.id,videoId),intent={action:'bind',expectedBindingRevision:before.bindingRevision,targetProjectId,expectedStoryboardRevision:view.revision,expectedAssetStamp:view.asset_stamp,shotIds:ids},preview=await v2.previewBinding(a.id,videoId,intent);return v2.bind(a.id,videoId,{...intent,requestId:randomUUID(),previewHash:preview.previewHash,...(preview.requiresConfirmation?{confirmUnbind:true,confirmedUnbindShotIds:preview.affectedShots.map(s=>s.shotId)}:{})});};
 const select=(videoId,{action='adopt-video',shotId,targetProjectId=a.id}={})=>{const state=v2.state(targetProjectId),binding=v2.sourceBinding(a.id,videoId),intent={action,expectedSelectionRevision:state.context.selectionRevision,expectedStoryboardRevision:state.context.storyboardRevision,sourceProjectId:a.id,videoId,bindingId:binding.binding.bindingId,expectedBindingRevision:binding.bindingRevision,...(shotId?{shotId}:{})},preview=v2.previewSelection(targetProjectId,intent);return v2.select(targetProjectId,{...intent,requestId:randomUUID(),previewHash:preview.previewHash,...(preview.requiresConfirmation?{confirmReplace:true}:{})});};
 return {dir,lib,db:lib.db,projects,assets,board,entry,catalog,v2,a,b,file,bytes,initialize,imported,bind,select};
}
