// 「待看的修改」的读取口径：从永久改动记录里分出真实修改和噪音。
// 只在读取时计算，不写库；storyboard_changes / storyboard_pending 的存量数据保持原样。
import {canonical} from '../project-assets/model.mjs';

/** 镜号顺延和原始导入数据：不算修改，改动记录里仍可查。 */
const NOISE=new Set(['$order','$number','source','import_source']);
const POSITION=new Set(['$order','$number','$scene_id']);
/** 这些字段的数组元素里夹着原始导入数据；只有它变了不算修改。dialogue[].source 是「声源」，属于正文，不能去掉。 */
const RAW_INSIDE=new Map([['characters','source'],['dialogue','import_source'],['audio_continuations','import_source']]);
const MOVE='$move';
const KIND_ORDER={document:0,scene:1,segment:2,shot:3};

const withoutRaw=(field,value)=>{
 const key=RAW_INSIDE.get(field);if(!key||!Array.isArray(value))return value;
 return value.map(x=>{if(!x||typeof x!=='object'||Array.isArray(x))return x;const copy={...x};delete copy[key];return copy;});
};
const isNoise=c=>NOISE.has(c.field)||RAW_INSIDE.has(c.field)&&canonical(withoutRaw(c.field,c.before??null))===canonical(withoutRaw(c.field,c.after??null));
const put=(target,key,value)=>Object.defineProperty(target,key,{value,enumerable:true,writable:true,configurable:true});

/** 在序列里留下最长的「相对顺序没变」的一串，其余才算被移动。ranks 是改后名次（1 起、互不相同）；prefer 为真的优先留下。 */
function keptInOrder(ranks,prefer){
 const n=ranks.length,unit=n+1,tree=new Array(n+1).fill(-1),score=new Array(n),previous=new Array(n);let last=-1;
 for(let i=0;i<n;i++){
  let best=-1;for(let r=ranks[i]-1;r>0;r-=r&-r)if(tree[r]>=0&&(best<0||score[tree[r]]>score[best]))best=tree[r];
  score[i]=(best<0?0:score[best])+unit+(prefer[i]?1:0);previous[i]=best;
  for(let r=ranks[i];r<=n;r+=r&-r)if(tree[r]<0||score[i]>score[tree[r]])tree[r]=i;
  if(last<0||score[i]>score[last])last=i;
 }
 const kept=new Set();for(let i=last;i>=0;i=previous[i])kept.add(i);return kept;
}

/** 只凭改动记录还原前后的全片顺序：没有记录的镜头镜号没变。数据对不上时返回 null（无法判断）。 */
function movesFromNumbers(records,gone,added){
 const before=new Map(),after=new Map(),taken=(map,n,token)=>{if(!Number.isSafeInteger(n)||n<1||map.has(n))return false;map.set(n,token);return true;};
 for(const n of gone)if(!taken(before,n,null))return null;
 for(const n of added)if(!taken(after,n,null))return null;
 for(const [id,r]of records)if(r.numbered&&(!taken(before,r.from,id)||!taken(after,r.to,id)))return null;
 if(!before.size&&!after.size)return new Set();
 const delta=added.length-gone.length,beforeCount=Math.max(...before.keys(),0,Math.max(...after.keys(),0)-delta),afterCount=beforeCount+delta;
 const walk=(map,count)=>{const out=[];for(let n=1;n<=count;n++){if(!map.has(n))out.push('='+n);else if(map.get(n)!==null)out.push(map.get(n));}return out;};
 const skip=id=>records.get(id)?.scene_from!==undefined,beforeList=walk(before,beforeCount).filter(id=>!skip(id)),afterList=walk(after,afterCount).filter(id=>!skip(id));
 if(beforeList.length!==afterList.length)return null;
 const rank=new Map(afterList.map((id,i)=>[id,i+1]));if(beforeList.some(id=>!rank.has(id)))return null;
 const kept=keptInOrder(beforeList.map(id=>rank.get(id)),beforeList.map(id=>id.startsWith('=')));
 return new Set(beforeList.filter((id,i)=>!kept.has(i)&&!id.startsWith('=')));
}

const places=project=>{const map=new Map();let number=0;for(const scene of project?.scenes??[])for(const [index,shot]of (scene.shots??[]).entries())map.set(shot.id,{scene:scene.id,index,number:++number});return map;};

/** 场次换序时整场镜头都会变号，改用前后两份完整版，在每场内部判断。 */
function movesWithinScenes(before,after){
 const a=places(before),b=places(after),moved=new Map();
 for(const scene of after?.scenes??[]){
  const stayed=[...(scene.shots??[])].filter(q=>a.get(q.id)?.scene===scene.id).sort((x,y)=>a.get(x.id).index-a.get(y.id).index);
  const rank=new Map([...stayed].sort((x,y)=>b.get(x.id).index-b.get(y.id).index).map((q,i)=>[q.id,i+1]));
  const kept=keptInOrder(stayed.map(q=>rank.get(q.id)),stayed.map(q=>a.get(q.id).index===b.get(q.id).index));
  stayed.forEach((q,i)=>{if(!kept.has(i))moved.set(q.id,{from:a.get(q.id).number,to:b.get(q.id).number});});
 }
 return moved;
}

function findMoves(changes,loadSnapshots){
 const records=new Map(),gone=[],added=[];let sceneOrderChanged=false;
 const record=c=>{if(!records.has(c.shot_id))records.set(c.shot_id,{from:c.shot_number_at_time,to:c.shot_number_at_time,numbered:false});return records.get(c.shot_id);};
 for(const c of changes){
  if(c.field==='$scene_order')sceneOrderChanged=true;
  if(c.target_kind!=='shot')continue;
  if(c.field==='$number')Object.assign(record(c),{from:c.before,to:c.after,numbered:true});
  else if(c.field==='$scene_id')Object.assign(record(c),{scene_from:c.before,scene_to:c.after});
  else if(c.field==='$entity'){const v=c.before??c.after;if(c.before)gone.push(v?.$number);else added.push(v?.$number);}
 }
 const moves=new Map();
 for(const [id,r]of records)if(r.scene_from!==undefined)moves.set(id,{from:r.from,to:r.to,scene_from:r.scene_from,scene_to:r.scene_to});
 if(sceneOrderChanged){
  const pair=loadSnapshots?.();   // 完整版已清理时无法判断，按噪音处理；场次换序本身仍显示在整体设置上
  if(pair)for(const [id,m]of movesWithinScenes(pair[0],pair[1]))if(!moves.has(id))moves.set(id,m);
 }else{
  const moved=movesFromNumbers(records,gone,added);
  for(const id of moved??[]){const r=records.get(id);moves.set(id,{from:r.from,to:r.to});}
 }
 return moves;
}

/** 一个版本里哪些目标有真实修改。结果只取决于该版的永久记录，可以按版本行缓存。 */
export function classifyVersion(changes,loadSnapshots){
 const targets=new Map(),entry=id=>{if(!targets.has(id))targets.set(id,{real:new Set(),move:null});return targets.get(id);};
 for(const c of changes)if(c.field!=='$summary'&&!POSITION.has(c.field)&&!isNoise(c))entry(c.target_id).real.add(c.field);
 for(const [shot,move]of findMoves(changes,loadSnapshots)){const t=entry('shot:'+shot);t.real.add(MOVE);t.move=move;}
 return {targets};
}

/** 只看字段名就能确定含真实修改的待看行，不必读改动记录。 */
export const plainlyReal=fields=>fields.some(f=>!NOISE.has(f)&&!RAW_INSIDE.has(f));

/** 待看行去噪后的字段。cls 为空表示这一版没有逐字段记录（只记摘要），只能按字段名判断，顺序变化按噪音处理。 */
export function realFields(row,fields,cls){
 const t=cls?.targets.get(row.target_id);
 if(t)return [...(t.real.has(MOVE)?[MOVE]:[]),...fields.filter(f=>t.real.has(f))];
 if(cls&&!plainlyReal(fields))return [];   // 记录齐全且只有噪音；字段名明确是真实修改时，宁可显示也不藏
 return [...new Set(fields.flatMap(f=>f==='$scene_id'?[MOVE]:NOISE.has(f)?[]:[f]))];
}

const brief=(kind,v)=>{
 if(!v||typeof v!=='object')return v??null;
 return kind==='shot'?{number:v.$number??null,framing:v.framing??'',action:v.action??''}:kind==='scene'?{name:v.name??''}:{};
};
const display=c=>c.field==='$entity'?brief(c.target_kind,c.before??null):withoutRaw(c.field,c.before??null);
const displayAfter=c=>c.field==='$entity'?brief(c.target_kind,c.after??null):withoutRaw(c.field,c.after??null);

function overview(project){
 const numbers=new Map(),scenes=new Map();let n=0;
 for(const scene of project?.scenes??[]){scenes.set(scene.id,scene.name??'');for(const shot of scene.shots??[])numbers.set(shot.id,++n);}
 return {numbers,scenes};
}
const movePoint=(number,scene,view)=>({number:number??null,scene_id:scene??null,scene_name:scene==null?null:view.scenes.get(scene)??null});

/** events 按版本从早到晚；同一目标跨多版时，每个字段取最早的改前和最新的改后。 */
function toItem(events,view){
 const last=events.at(-1),t=last.target,summary=events.some(e=>e.meta.summary_only),before={},after={};
 if(!summary)for(const e of events){
  if(e.move){if(!Object.hasOwn(before,MOVE))put(before,MOVE,movePoint(e.move.from,e.move.scene_from,view));put(after,MOVE,movePoint(e.move.to,e.move.scene_to,view));}
  for(const c of e.changes){if(!e.fields.includes(c.field))continue;if(!Object.hasOwn(before,c.field))put(before,c.field,display(c));put(after,c.field,displayAfter(c));}
 }
 return {target_kind:t.target_kind,target_id:t.target_id,shot_id:t.shot_id,shot_number:t.shot_number_at_time,current_number:t.shot_id?view.numbers.get(t.shot_id)??null:null,deleted:!!t.deleted,versions:events.map(e=>e.meta.version),fields:[...new Set(events.flatMap(e=>e.fields))],author_kind:last.meta.author_kind,reason_category:last.meta.reason_category,reason_text:last.meta.reason_text,summary_only:summary,before:summary?null:before,after:summary?null:after,events:events.map(e=>({...e.meta,fields:e.fields}))};
}
const sorted=items=>items.sort((a,b)=>KIND_ORDER[a.target_kind]-KIND_ORDER[b.target_kind]||(a.shot_number??0)-(b.shot_number??0)||a.target_id.localeCompare(b.target_id));
const metaOf=r=>({version:r.version,created_at:r.version_created_at,author_kind:r.author_kind,reason_category:r.reason_category,reason_text:r.reason_text,summary_only:!!r.version_summary_only});

/** 未看记录去噪后的事件，按版本从早到晚；计数和列表共用，两边口径不会分叉。 */
function collectEvents({rows,classes,changes}){
 const events=[],index=new Map();
 const inVersion=(version,target)=>{if(!index.has(version))index.set(version,Map.groupBy(changes.get(version)??[],c=>c.target_id));return index.get(version).get(target)??[];};
 for(const row of rows){
  const cls=classes.get(row.version),fields=realFields(row,JSON.parse(row.fields_json),cls);if(!fields.length)continue;
  events.push({target:row,meta:metaOf(row),fields,changes:inVersion(row.version,row.target_id),move:cls?.targets.get(row.target_id)?.move??null});
 }
 return events;
}

const sameValue=(field,a,b)=>{const norm=v=>field==='$entity'?v??null:withoutRaw(field,v??null);return canonical(norm(a))===canonical(norm(b));};
function sameMove(seen){
 if(seen.length<2||seen.some(e=>!e.move))return false;   // 只移动过一次就是真实移动；缺记录按有变化
 const first=seen[0].move,last=seen.at(-1).move;
 if(!Number.isSafeInteger(first.from)||first.from!==last.to)return false;
 return seen.find(e=>e.move.scene_from!==undefined)?.move.scene_from===seen.findLast(e=>e.move.scene_to!==undefined)?.move.scene_to;
}
/** 所有未看记录合起来是否净无变化。只记摘要或缺逐字段记录时无法判断，一律算有变化。 */
function netUnchanged(events){
 if(events.length<2||events.some(e=>e.meta.summary_only))return false;
 const records=new Map();
 for(const field of new Set(events.flatMap(e=>e.fields))){
  const seen=events.filter(e=>e.fields.includes(field));
  if(field===MOVE)continue;
  const list=seen.map(e=>e.changes.find(c=>c.field===field));if(list.some(c=>!c))return false;
  records.set(field,{seen,list});
 }
 const entity=records.get('$entity');
 // 最早记录之前和最新记录之后都不存在：中途出现又消失，中途改过什么都不算最终变化。
 if(entity&&entity.seen[0]===events[0]&&entity.seen.at(-1)===events.at(-1)&&entity.list[0].before==null&&entity.list.at(-1).after==null)return true;
 if(events.some(e=>e.fields.includes(MOVE))&&!sameMove(events.filter(e=>e.fields.includes(MOVE))))return false;
 for(const [field,{list}]of records)if(!sameValue(field,list[0].before,list.at(-1).after))return false;
 return true;
}

/** 待看计数：原有两项按未看目标；net_ 两项去掉净无变化的目标。 */
export function pendingCounts(input){
 const counts={pending_count:0,pending_document_count:0,net_pending_count:0,net_pending_document_count:0};
 for(const list of Map.groupBy(collectEvents(input),e=>e.target.target_id).values()){
  const shot=list[0].target.target_kind==='shot';counts[shot?'pending_count':'pending_document_count']++;
  if(!netUnchanged(list))counts[shot?'net_pending_count':'net_pending_document_count']++;
 }
 return counts;
}

/** 组装待看：items 是「全部未看」（按目标合并），pending_versions 是按版本的视图（新到旧，只含还有真实未看内容的版本）。 */
export function pendingView({rows,classes,changes,project,revision}){
 const view=overview(project),events=collectEvents({rows,classes,changes});
 const items=sorted([...Map.groupBy(events,e=>e.target.target_id).values()].map(list=>({...toItem(list,view),net_unchanged:netUnchanged(list)})));
 const pending_versions=[...Map.groupBy(events,e=>e.meta.version).entries()].sort((a,b)=>b[0]-a[0]).map(([version,list])=>({...list[0].meta,is_current:version===revision,item_count:list.length,items:sorted(list.map(e=>toItem([e],view)))}));
 return {items,pending_versions};
}

/** 改动记录里展开一版：和待看同样的条目，噪音单独列出（永远可查）。 */
export function versionView({meta,changes,cls,project}){
 const view=overview(project),items=[],noise=[];
 for(const [id,list]of Map.groupBy(changes.filter(c=>c.field!=='$summary'),c=>c.target_id)){
  const c=list[0],t=cls.targets.get(id),fields=t?[...t.real]:[];
  const target={target_kind:c.target_kind,target_id:id,shot_id:c.shot_id,shot_number_at_time:c.shot_number_at_time,deleted:list.some(x=>x.deleted)};
  if(fields.length)items.push(toItem([{target,meta,fields,changes:list,move:t.move}],view));
  const hasNumber=list.some(x=>x.field==='$number');
  for(const x of list){
   if(t?.real.has(x.field)||t?.move&&POSITION.has(x.field)||x.field==='$order'&&hasNumber)continue;
   noise.push({target_kind:x.target_kind,target_id:id,shot_id:x.shot_id,shot_number:x.shot_number_at_time,field:x.field,...(POSITION.has(x.field)?{before:x.before??null,after:x.after??null}:{})});
  }
 }
 return {items:sorted(items),noise:noise.sort((a,b)=>(a.shot_number??0)-(b.shot_number??0))};
}
