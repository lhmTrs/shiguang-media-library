const stable=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const bytes=v=>new TextEncoder().encode(stable(v??null)).length;
const ignored=new Set(['id','revision','document_id','bound_project_id','project_id']);
function entities(project){
 const result=new Map();if(!project)return result;
 const root={...project};delete root.scenes;
 result.set('document:$document',{kind:'document',id:'$document',value:{...root,$scene_order:(project.scenes??[]).map(s=>s.id)},number:null});
 let number=0;
 for(const scene of project.scenes??[]){
  const value={...scene};delete value.shots;result.set('scene:'+scene.id,{kind:'scene',id:scene.id,value,number:null});
  for(const [index,shot]of (scene.shots??[]).entries())result.set('shot:'+shot.id,{kind:'shot',id:shot.id,value:{...shot,$scene_id:scene.id,$order:index,$number:number+1},number:++number});
 }
 return result;
}
export function storyboardDiff(before,after){
 const left=entities(before),right=entities(after),changes=[];let unionFieldCount=0,changedContentBytes=0,unionContentBytes=0;
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
 const metrics={changedFieldCount:changes.length,unionFieldCount,changedContentBytes,unionContentBytes};
 return {summary_only:changes.length>unionFieldCount/2||changedContentBytes>unionContentBytes/2,metrics,changes};
}
