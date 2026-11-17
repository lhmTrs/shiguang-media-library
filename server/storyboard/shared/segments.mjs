// Pure shared rules: no storage, platform calls or ID allocation.
export const SEGMENT_MODES = Object.freeze(['seedance_2_5', 'seedance_2_0', 'camera', 'custom']);
const copy = value => structuredClone(value);
const shots = project => (project.scenes ?? []).flatMap(scene => scene.shots ?? []);
const unique = values => [...new Set(values)];
const fail = (code, message, details = {}) => { throw Object.assign(new Error(message), {status:400, code, details}); };
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(id);
const defaults = () => ({mode:'seedance_2_5', custom_limit_ms:null});
export function segmentNameParts(name) {
 const match = typeof name === 'string' && /^([A-Z]+)([1-9][0-9]*)?$/.exec(name);
 if (!match) fail('SEGMENT_NAME_INVALID', '段名须为大写基础字母及可选正整数后缀', {name});
 // BigInt prevents ordering/rounding errors for long names and suffixes.
 let order = 0n; for (const c of match[1]) order = order * 26n + BigInt(c.charCodeAt(0)-64);
 return {base:match[1], suffix:match[2] ?? null, order};
}
export function compareSegmentNames(a,b) {
 const x=segmentNameParts(a), y=segmentNameParts(b);
 if(x.order!==y.order)return x.order<y.order?-1:1;
 const n=BigInt(x.suffix??0),m=BigInt(y.suffix??0);return n===m?0:n<m?-1:1;
}
export function getSegmentLimit(settings = defaults()) {
 if(!settings || !SEGMENT_MODES.includes(settings.mode))fail('SEGMENT_MODE_INVALID','分割模式无效',{path:'segment_settings'});
 if(settings.mode==='custom') {
  if(!Number.isSafeInteger(settings.custom_limit_ms)||settings.custom_limit_ms<=0)fail('SEGMENT_MODE_INVALID','自定义上限须为正安全整数毫秒',{path:'segment_settings.custom_limit_ms'});
  return settings.custom_limit_ms;
 }
 return settings.mode==='camera'?null:settings.mode==='seedance_2_0'?15000:30000;
}
export function withSegments(project) {
 const p=copy(project), all=shots(p);
 if(p.segments===undefined)p.segments=all.length?[{id:`legacy_${p.document_id??p.project_id}_A`,name:'A',start_shot_id:all[0].id}]:[];
 if(!all.length && p.segments?.length===1 && p.segments[0].name==='A' && p.segments[0].start_shot_id===null)p.segments=[];
 if(!Array.isArray(p.segments))fail('SEGMENT_STRUCTURE_INVALID','segments须为数组',{path:'segments'});
 if(p.segments.some(s=>!s||typeof s!=='object'))fail('SEGMENT_STRUCTURE_INVALID','段须为对象',{path:'segments'});
 if(p.segment_settings===undefined)p.segment_settings=defaults();
 p.segment_used_names=unique([...(Array.isArray(p.segment_used_names)?p.segment_used_names:[]),...p.segments.map(s=>s.name)]);
 p.segment_used_ids=unique([...(Array.isArray(p.segment_used_ids)?p.segment_used_ids:[]),...p.segments.map(s=>s.id)]);
 return p;
}
export function validateSegmentStructure(project) {
 const all=shots(project), segments=project.segments;
 getSegmentLimit(project.segment_settings);
 if(!Array.isArray(segments))fail('SEGMENTS_REQUIRED','须提供分段；最小补法为一段A，起始为第一镜',{path:'segments',example:[{id:'segment_A',name:'A',start_shot_id:all[0]?.id??null}]});
 const positions=new Map(all.map((s,i)=>[s.id,i]));
 if(positions.size!==all.length)fail('SEGMENT_STRUCTURE_INVALID','镜头ID重复');
 if((all.length===0)!==(segments.length===0))fail('SEGMENT_STRUCTURE_INVALID','非空分镜必须分段，空分镜须使用空段列表');
 const names=new Set(),ids=new Set();let previous=-1;
 for(const [i,segment]of segments.entries()) {
  if(!segment || !validId(segment.id))fail('SEGMENT_STRUCTURE_INVALID','段ID无效',{path:`segments[${i}].id`});
  segmentNameParts(segment.name);
  if(ids.has(segment.id))fail('SEGMENT_STRUCTURE_INVALID','段ID重复',{segment_id:segment.id});
  if(names.has(segment.name))fail('SEGMENT_NAME_DUPLICATE','段名重复',{segment_id:segment.id,name:segment.name});
  ids.add(segment.id);names.add(segment.name);
  const at=positions.get(segment.start_shot_id);
  if(at===undefined||at<=previous||(i===0&&at!==0))fail('SEGMENT_STRUCTURE_INVALID','切点须从第一镜开始且按全局镜序严格递增',{segment_id:segment.id,path:`segments[${i}].start_shot_id`});
  previous=at;
 }
 return project;
}
export function segmentSummary(project) {
 const p=withSegments(project);validateSegmentStructure(p);
 const all=shots(p),positions=new Map(all.map((s,i)=>[s.id,i])),limit=getSegmentLimit(p.segment_settings);
 const segments=p.segments.map((s,i)=>{
  const start=positions.get(s.start_shot_id),end=i+1<p.segments.length?positions.get(p.segments[i+1].start_shot_id):all.length;
  const members=all.slice(start,end);let duration_ms=0;
  for(const shot of members) {
   if(!Number.isSafeInteger(shot.duration_ms)||shot.duration_ms<=0||!Number.isSafeInteger(duration_ms+shot.duration_ms))fail('SEGMENT_STRUCTURE_INVALID','镜头及段总时长须为正安全整数毫秒',{segment_id:s.id,shot_id:shot.id});
   duration_ms+=shot.duration_ms;
  }
  return {...s,end_shot_id:members.at(-1).id,start_number:String(start+1).padStart(2,'0'),end_number:String(end).padStart(2,'0'),shot_ids:members.map(q=>q.id),shot_count:members.length,duration_ms,overlong:limit!==null&&duration_ms>limit};
 });
 return {segment_settings:p.segment_settings,limit_ms:limit,used_names:p.segment_used_names,used_ids:p.segment_used_ids,segments};
}
export function nextSegmentName(project,segmentId) {
 const p=withSegments(project),s=p.segments.find(s=>s.id===segmentId);
 if(!s)fail('SEGMENT_STRUCTURE_INVALID','找不到要切开的段',{segment_id:segmentId});
 const base=segmentNameParts(s.name).base,used=new Set(p.segment_used_names);let suffix=1n;
 while(used.has(base+suffix))suffix++;
 return base+suffix;
}
export function nearestEmptyBase(project,segmentId) {
 const p=withSegments(project),i=p.segments.findIndex(s=>s.id===segmentId);
 if(i<0)fail('SEGMENT_STRUCTURE_INVALID','找不到段',{segment_id:segmentId});
 const lower=segmentNameParts(p.segments[i].name).order,upper=i+1<p.segments.length?segmentNameParts(p.segments[i+1].name).order:null;
 const active=new Set(p.segments.map(s=>s.name));
 return p.segment_used_names.filter(name=>{const n=segmentNameParts(name);return n.suffix===null&&!active.has(name)&&n.order>lower&&(upper===null||n.order<upper);}).sort(compareSegmentNames)[0]??null;
}
export function splitSegment(project,shotId,{id,name}={}) {
 const p=withSegments(project),summary=segmentSummary(p),i=summary.segments.findIndex(s=>s.shot_ids.includes(shotId));
 if(i<0||p.segments[i].start_shot_id===shotId)fail('SEGMENT_STRUCTURE_INVALID','只能在段内非首镜处切开',{shot_id:shotId});
 if(!validId(id)||p.segment_used_ids.includes(id))fail('SEGMENT_ID_REUSED','新段须使用未用过的有效ID',{segment_id:id});
 p.segments.splice(i+1,0,{id,name:name??nextSegmentName(p,p.segments[i].id),start_shot_id:shotId});
 validateSegmentStructure(p);return withSegments(p);
}
export function mergeSegment(project,segmentId) {
 const p=withSegments(project),i=p.segments.findIndex(s=>s.id===segmentId);
 if(i<=0)fail('SEGMENT_STRUCTURE_INVALID','第一段不能向前合并',{segment_id:segmentId});
 p.segments.splice(i,1);return p;
}
function baseName(index) {let result='';while(index>0){index--;result=String.fromCharCode(65+index%26)+result;index=Math.floor(index/26);}return result;}
export function reconcileSegmentCuts(before,next,{insertions=[],firstSegmentId}={}) {
 const old=withSegments(before),p=copy(next),previous=segmentSummary(old),all=shots(p),oldShots=new Set(shots(old).map(s=>s.id)),membership=new Map();
 for(const s of previous.segments)for(const id of s.shot_ids)membership.set(id,s.id);
 const added=all.filter(s=>!oldShots.has(s.id)),hints=new Map(insertions.map(h=>[h.shot_id,h]));
 for(const shot of added) {
  const hint=hints.get(shot.id);
  if(!hint && old.segments.length>1)fail('SEGMENT_INSERT_CONTEXT_REQUIRED','多段插入须明确锚点镜头及前后位置',{shot_id:shot.id});
  if(hint) {
   const group=membership.get(hint.anchor_shot_id);
   if(!group||!['before','after'].includes(hint.side))fail('SEGMENT_INSERT_CONTEXT_REQUIRED','插入归属锚点无效',{shot_id:shot.id});
   const at=all.findIndex(s=>s.id===shot.id),anchor=all.findIndex(s=>s.id===hint.anchor_shot_id);
   if(anchor<0||(hint.side==='before'?at>=anchor:at<=anchor))fail('SEGMENT_INSERT_CONTEXT_REQUIRED','插入位置与锚点方向不符',{shot_id:shot.id});
   membership.set(shot.id,group);
  }else if(old.segments.length===1)membership.set(shot.id,old.segments[0].id);
 }
 const retained=old.segments.map(s=>{const first=all.find(q=>membership.get(q.id)===s.id);return first?{...s,start_shot_id:first.id}:null;}).filter(Boolean);
 if(!old.segments.length&&all.length) {
  if(!validId(firstSegmentId)||old.segment_used_ids.includes(firstSegmentId))fail('SEGMENT_ID_REUSED','空稿新增首段须提供未用ID');
  let index=1;while(old.segment_used_names.includes(baseName(index)))index++;
  retained.push({id:firstSegmentId,name:baseName(index),start_shot_id:all[0].id});
 }
 p.segments=retained;p.segment_settings=copy(old.segment_settings);p.segment_used_names=copy(old.segment_used_names);p.segment_used_ids=copy(old.segment_used_ids);
 validateSegmentStructure(p);
 // A reorder which interleaves old memberships cannot be repaired unambiguously.
 const summary=segmentSummary(p);
 for(const s of summary.segments)for(const id of s.shot_ids)if(membership.has(id)&&membership.get(id)!==s.id)fail('SEGMENT_STRUCTURE_INVALID','原段镜头交错，须显式提供合法切点');
 return withSegments(p);
}
export function validateSegmentSave(previous,candidate,{kind='save',author='user',overwrites=[]}={}) {
 if(!['save','initialize','restore'].includes(kind))fail('SEGMENT_STRUCTURE_INVALID','未知分段保存操作');
 const old=previous?withSegments(previous):null;let p=copy(candidate);
 if(kind==='initialize'&&p.segments===undefined)validateSegmentStructure(p);
 if(kind==='save'&&p.segments===undefined) {
  if(old?.segments.length>1)fail('SEGMENTS_REQUIRED','已有多段，保存必须明确提供segments');
  if(old)p=reconcileSegmentCuts(old,p);else p=withSegments(p);
 }else p=withSegments(p);
 if(candidate.segment_settings===undefined&&old&&kind==='save')p.segment_settings=copy(old.segment_settings);
 const current=segmentSummary(p),prior=old?segmentSummary(old):{segments:[],used_names:[],used_ids:[]};
 const oldById=new Map(prior.segments.map(s=>[s.id,s]));
 if(kind==='save')for(const s of current.segments) {
  const was=oldById.get(s.id);
  if(was) {if(was.name!==s.name)fail('SEGMENT_NAME_IMMUTABLE','已有段不可改名',{segment_id:s.id});continue;}
  if(prior.used_ids.includes(s.id))fail('SEGMENT_ID_REUSED','不可复用退役段ID',{segment_id:s.id});
  if(prior.used_names.includes(s.name)) {
   const index=current.segments.findIndex(q=>q.id===s.id),parent=current.segments[index-1],candidateView=copy(p);
   // Compute the nearest candidate with this newly claimed name still absent.
   candidateView.segments=candidateView.segments.filter(q=>q.id!==s.id);
   candidateView.segment_used_names=prior.used_names;
   const permitted=author==='user'&&parent&&overwrites.some(o=>o.segment_id===s.id&&o.name===s.name)&&segmentNameParts(s.name).suffix===null&&nearestEmptyBase(candidateView,parent.id)===s.name;
   if(!permitted)fail('SEGMENT_NAME_REUSED','该段名已使用，只有用户明确覆盖最近空基础字母才可复用',{segment_id:s.id,name:s.name});
  }
 }
 const bad=current.segments.filter(s=>s.overlong&&(kind==='initialize'||(kind==='save'&&(!oldById.has(s.id)||s.duration_ms>oldById.get(s.id).duration_ms))));
 if(bad.length)fail('SEGMENT_TOO_LONG','分段时长超出当前模式上限',{operation:kind,segments:bad.map(s=>({id:s.id,name:s.name,duration_ms:s.duration_ms,previous_duration_ms:oldById.get(s.id)?.duration_ms??null,limit_ms:current.limit_ms}))});
 p.segment_used_names=unique([...(kind==='initialize'?[]:prior.used_names),...(kind==='restore'?current.used_names:[]),...p.segments.map(s=>s.name)]);
 p.segment_used_ids=unique([...prior.used_ids,...(kind==='restore'?current.used_ids:[]),...p.segments.map(s=>s.id)]);
 return p;
}
export function segmentChanges(before,after) {
 const left=before?segmentSummary(before):{segments:[]},right=after?segmentSummary(after):{segments:[]},events=[];
 const a=new Map(left.segments.map(s=>[s.id,s])),b=new Map(right.segments.map(s=>[s.id,s]));
 const point=s=>s?{start_shot_id:s.start_shot_id,start_number:s.start_number}:null;
 for(const id of unique([...a.keys(),...b.keys()])) {
  const old=a.get(id),next=b.get(id),s=next??old;
  if(old&&next&&old.start_shot_id===next.start_shot_id&&old.name===next.name)continue;
  const retired=!old&&left.segments.find(q=>q.name===s.name);
  const event={type:!old?(retired?'overwrite':'add'):!next?'remove':'move_start',segment_id:id,name:s.name,before:point(old),after:point(next)};
  if(retired)event.previous_name=retired.name;
  if(!next){const index=left.segments.findIndex(q=>q.id===id),parent=left.segments.slice(0,index).reverse().find(q=>b.has(q.id));if(parent)event.merged_into={id:parent.id,name:parent.name};}
  events.push(event);
 }
 return events;
}
