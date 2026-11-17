import {withSegments, segmentChanges} from './segments.mjs';
const stable=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const bytes=v=>new TextEncoder().encode(stable(v??null)).length;
const ignored=new Set(['id','revision','document_id','bound_project_id','project_id']);
function entities(project){
 const result=new Map();if(!project)return result;
 const root={...project};delete root.scenes;
 for(const field of ['segments','segment_settings','segment_used_names','segment_used_ids'])delete root[field];
 result.set('document:$document',{kind:'document',id:'$document',value:{...root,$scene_order:(project.scenes??[]).map(s=>s.id)},number:null});
 let number=0;
 for(const scene of project.scenes??[]){
  const value={...scene};delete value.shots;result.set('scene:'+scene.id,{kind:'scene',id:scene.id,value,number:null});
  for(const [index,shot]of (scene.shots??[]).entries())result.set('shot:'+shot.id,{kind:'shot',id:shot.id,value:{...shot,$scene_id:scene.id,$order:index,$number:number+1},number:++number});
 }
 return result;
}
export function storyboardDiff(before,after){
 const segmentAware=before?.segments!==undefined||after?.segments!==undefined;
 const oldProject=before&&segmentAware?withSegments(before):before,newProject=after&&segmentAware?withSegments(after):after;
 const left=entities(oldProject),right=entities(newProject),changes=[];let unionFieldCount=0,changedContentBytes=0,unionContentBytes=0;
 for(const key of new Set([...left.keys(),...right.keys()])){
  const a=left.get(key),b=right.get(key),entity=b||a;
  const cells=!a||!b?['$entity']:[...new Set([...Object.keys(a.value),...Object.keys(b.value)])].filter(f=>!ignored.has(f));
  for(const field of cells){
   const old=field==='$entity'?a?.value??null:a.value[field]??null,newValue=field==='$entity'?b?.value??null:b.value[field]??null;
   const size=bytes(old)+bytes(newValue);unionFieldCount++;unionContentBytes+=size;
   if(stable(old)===stable(newValue))continue;
   changedContentBytes+=size;
   changes.push({target_kind:entity.kind,target_id:key,shot_id:entity.kind==='shot'?entity.id:null,shot_number_at_time:entity.number,field,before:old,after:newValue,deleted:!b});
  }
 }
 if(segmentAware){
  const a=new Map((oldProject?.segments??[]).map(s=>[s.id,s])),b=new Map((newProject?.segments??[]).map(s=>[s.id,s]));
  const events=new Map(segmentChanges(oldProject,newProject).map(e=>[e.segment_id,e]));
  for(const id of new Set([...a.keys(),...b.keys()])){
   const old=a.get(id)??null,value=b.get(id)??null,size=bytes(old)+bytes(value);unionFieldCount++;unionContentBytes+=size;
   if(stable(old)===stable(value))continue;
   changedContentBytes+=size;changes.push({target_kind:'segment',target_id:'segment:'+id,shot_id:null,shot_number_at_time:null,field:'$segment',before:old,after:value,deleted:!value,segment_event:events.get(id)});
  }
  const old=oldProject?.segment_settings??null,value=newProject?.segment_settings??null,size=bytes(old)+bytes(value);unionFieldCount++;unionContentBytes+=size;
  if(stable(old)!==stable(value)){changedContentBytes+=size;changes.push({target_kind:'document',target_id:'document:$document',shot_id:null,shot_number_at_time:null,field:'$segment_settings',before:old,after:value,deleted:false,segment_event:{type:'mode',before:old,after:value}});}
  const memberships=new Map(),starts=new Map((newProject?.segments??[]).map(s=>[s.start_shot_id,s]));let group=null;
  for(const scene of newProject?.scenes??[])for(const shot of scene.shots??[]){if(starts.has(shot.id))group=starts.get(shot.id);if(group)memberships.set(shot.id,group);}
  for(const c of changes)if(c.target_kind==='shot'&&c.field==='$entity'&&c.after){
   const segment=memberships.get(c.shot_id);if(segment)c.segment_context={id:segment.id,name:segment.name,anchor_shot_id:null,side:null};
  }
 }
 const metrics={changedFieldCount:changes.length,unionFieldCount,changedContentBytes,unionContentBytes};
 return {summary_only:changes.length>unionFieldCount/2||changedContentBytes>unionContentBytes/2,metrics,changes};
}
