import {createHash} from 'node:crypto';
export const canonical=value=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
export const fail=(code,message,status=400,details={})=>{throw Object.assign(new Error(message),{code,status,details});};
export const rows=project=>(project.scenes??[]).flatMap(scene=>(scene.shots??[]).map(shot=>({shot,scene}))).map((r,index)=>({...r,index,number:String(index+1).padStart(2,'0')}));
const clean=value=>typeof value==='string'?value.normalize('NFC').replace(/\r\n?/g,'\n').trim():Array.isArray(value)?value.map(clean):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([k])=>!['revision','asset_revision'].includes(k)).map(([k,v])=>[k,clean(v)])):value??null;
const pick=(value,keys)=>Object.fromEntries(keys.map(k=>[k,clean(value?.[k]??null)]));
const sorted=value=>[...(value??[])].map(clean).sort((a,b)=>canonical(a).localeCompare(canonical(b)));
export const REVIEW_CATEGORIES=['framing','action','camera','duration','first_frame','continuity','sound_dialogue','characters','references','audio_continuation','scene','shot_range','video_content','dependency_unverifiable'];
const applicable=(b,row)=>(!b.scene_ids?.length||b.scene_ids.includes(row.scene.id))&&(!b.shot_ids?.length||b.shot_ids.includes(row.shot.id));
export function orderedShotIds(project,ids){
 if(!Array.isArray(ids)||!ids.length||ids.length>5000||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length)fail('VIDEO_V2_INVALID_INPUT','请选择非空唯一有序镜头ID');
 const positions=new Map(rows(project).map(r=>[r.shot.id,r.index]));let last=-1;
 for(const id of ids){const index=positions.get(id);if(index===undefined)fail('SHOT_NOT_FOUND','镜头不属于指定分镜版本',404,{shotId:id});if(index<=last)fail('VIDEO_V2_INVALID_INPUT','镜头ID必须按该版全片顺序排列');last=index;}
 return ids;
}
export function captureSnapshot({project,context,shotIds,dependencies={},allowMissing=false}){
 if(!allowMissing)orderedShotIds(project,shotIds);
 const all=rows(project),selected=new Set(shotIds),dialogues=new Map(all.flatMap(r=>(r.shot.dialogue??[]).map(d=>[d.id,{...d,source_shot_id:r.shot.id}]))),shots=[];
 for(const row of all.filter(r=>selected.has(r.shot.id))){
  const q=row.shot,dep=dependencies[q.id]??{},refs=[...(project.reference_bindings??[]),...(q.reference_bindings??[])].filter(b=>applicable(b,row));
  const categories={
   framing:clean(q.framing),action:pick(q,['action','physical_feedback','environment_feedback','result']),camera:clean(q.camera),duration:q.duration_ms,first_frame:clean(q.first_frame),continuity:clean(q.continuity),
   sound_dialogue:{sound:clean(q.sound),dialogue:(q.dialogue??[]).map(d=>pick(d,['character_id','source','text','performance','listener_ids','listeners']))},
   characters:{ids:sorted(q.character_ids),presence:sorted(q.character_presence),dependencies:clean(dep.characters??[])},
   references:{bindings:sorted(refs.map(b=>{const result={...b};delete result.id;return result;})),dependencies:clean(dep.references??[])},
   audio_continuation:{continuations:(q.audio_continuations??[]).map(c=>({...clean(c),dialogue:clean(dialogues.get(c.dialogue_id)??null)})),dependencies:clean(dep.audio_continuation??[])},
   scene:{...pick(row.scene,['location','story_time','interior_exterior','spatial_setup','scene_asset_id']),dependencies:clean(dep.scene??[])}
  };
  shots.push({shotId:q.id,number:row.number,durationMs:q.duration_ms,ordinal:row.index,categories,unverifiable:[...(dep.unverifiable??[])]});
 }
 // Separate contiguous selected runs: gaps remain uncovered, never inferred by numbers.
 const runs=[];for(const shot of shots){const last=runs.at(-1);if(last&&last.endOrdinal+1===shot.ordinal){last.endId=shot.shotId;last.endOrdinal=shot.ordinal;last.shotIds.push(shot.shotId);}else runs.push({startId:shot.shotId,endId:shot.shotId,startOrdinal:shot.ordinal,endOrdinal:shot.ordinal,shotIds:[shot.shotId]});}
 const generationInput={settings:clean(project.settings??{}),global_rules:clean(project.global_rules??{}),synopsis:clean(project.synopsis??''),characters:clean(project.characters??[]),scenes:[...new Map(all.filter(r=>selected.has(r.shot.id)).map(r=>[r.scene.id,clean(Object.fromEntries(Object.entries(r.scene).filter(([key])=>key!=='shots')))])).values()],shots:all.filter(r=>selected.has(r.shot.id)).map(r=>clean(r.shot))};
 const snapshot={schemaVersion:1,generationInput,context:{instanceId:context.instanceId,projectId:context.projectId,documentId:context.documentId,initializedAt:context.initializedAt,storyboardRevision:context.storyboardRevision},shotIds:[...shotIds],order:all.map(r=>r.shot.id),runs,shots};
 return {...snapshot,inputHash:hash(snapshot)};
}
export function compareSnapshot(baseline,current,{videoChanged=false,mediaVerified=true}={}){
 const reasons=new Map(),add=(category,ids)=>{const found=reasons.get(category)??new Set();for(const id of ids)found.add(id);reasons.set(category,found);};
 const sameDocument=baseline.context.documentId===current.context.documentId&&baseline.context.initializedAt===current.context.initializedAt;
 const oldById=new Map(baseline.shots.map(s=>[s.shotId,s])),newById=new Map(current.shots.map(s=>[s.shotId,s]));
 const missing=baseline.shotIds.filter(id=>!newById.has(id));
 if(!sameDocument)add('shot_range',baseline.shotIds);
 if(missing.length)add('shot_range',missing);
 const positions=new Map(current.order.map((id,i)=>[id,i])),oldIds=new Set(baseline.order);
 const currentSelected=current.order.filter(id=>oldById.has(id));
 if(canonical(currentSelected)!==canonical(baseline.shotIds.filter(id=>newById.has(id))))add('shot_range',baseline.shotIds);
 for(const run of baseline.runs){const a=positions.get(run.startId),b=positions.get(run.endId);if(a!==undefined&&b!==undefined&&b>=a){const added=current.order.slice(a,b+1).filter(id=>!oldIds.has(id));if(added.length)add('shot_range',added);}}
 for(const [id,old]of oldById){const next=newById.get(id);if(!next)continue;for(const category of Object.keys(old.categories))if(canonical(old.categories[category])!==canonical(next.categories[category]))add(category,[id]);if(next.unverifiable.length)add('dependency_unverifiable',[id]);}
 if(videoChanged)add('video_content',baseline.shotIds);
 if(!mediaVerified)add('dependency_unverifiable',baseline.shotIds);
 const items=REVIEW_CATEGORIES.filter(category=>reasons.has(category)).map(category=>({category,shotIds:[...reasons.get(category)]}));
 const canReview=sameDocument&&!missing.length&&mediaVerified&&!reasons.has('dependency_unverifiable');
 return {needsReview:items.length>0,reasons:items,canReview,disabledReason:!sameDocument?'STORYBOARD_GENERATION_CHANGED':missing.length?'SHOT_NOT_FOUND':!mediaVerified?'VIDEO_UNVERIFIED':reasons.has('dependency_unverifiable')?'DEPENDENCY_UNVERIFIABLE':null};
}
