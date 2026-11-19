import {rows} from './model.mjs';
import {shotReferenceRows,bindingImageFields} from '../storyboard/asset-references.mjs';
const json=row=>row?.data_json?JSON.parse(row.data_json):{};
const master=row=>row?{id:row.id,name:row.name,...Object.fromEntries(Object.entries(json(row)).filter(([key])=>['name','base_info','performance_info','details','description','appearance','age','role','tags'].includes(key)))}:null;
// SQL/cached metadata only. Reads never stat, hash or probe media.
export function snapshotDependencies(board,view,shotIds){
 const project=view.project,resolver=board.referenceResolver(view.project_id??project.bound_project_id),selected=new Set(shotIds),all=rows(project),byId=new Map(all.map(r=>[r.shot.id,r]));
 const fileIds=new Map((project.assets??[]).map(a=>[a.id,a])),characters=new Map((view.canonical_characters??[]).map(c=>[c.id,c]));
 const result={};
 for(const row of all.filter(r=>selected.has(r.shot.id))){
  const shot=row.shot,dep={characters:[],references:[],scene:[],audio_continuation:[],unverifiable:[]},usedLooks=new Set(),usedImages=new Set();
  const missing=(type,id)=>dep.unverifiable.push(type+':'+id);
  const readAsset=(id,category)=>{const asset=resolver.asset(id);if(!asset)missing('asset',id);else dep[category].push(master(asset));return asset;};
  const image=id=>{if(usedImages.has(id))return;usedImages.add(id);const binding=resolver.image(id);if(!binding){missing('image',id);return;}
   const media=board.db.prepare('SELECT * FROM assets WHERE id=?').get(binding.media_asset_id);
   const root=media?board.db.prepare('SELECT * FROM roots WHERE id=?').get(media.root_id):null;
   if(!root||root.retired||root.online===0||!media||media.trashed||!binding.expected_sha256||(media.sha256&&binding.expected_sha256!==media.sha256)||media.online===0||['missing','changed','unreadable'].includes(media.file_status))missing('image-content',id);
   dep.references.push({id:binding.id,assetId:binding.asset_id,lookId:binding.look_id,data:json(binding),expectedSha256:binding.expected_sha256,mediaId:binding.media_asset_id,sha256:binding.expected_sha256});
  };
  const look=id=>{if(!id||usedLooks.has(id))return;usedLooks.add(id);const item=resolver.look(id);if(!item){missing('look',id);return;}dep.references.push({id:item.id,assetId:item.asset_id,data:json(item)});};
  const ids=new Set([...(shot.character_ids??[]),...(shot.character_presence??[]).map(c=>c.character_id),...(shot.dialogue??[]).map(d=>d.character_id)]);
  for(const continuation of shot.audio_continuations??[]){const from=byId.get(continuation.source_shot_id),dialogue=from?.shot.dialogue?.find(d=>d.id===continuation.dialogue_id);if(!dialogue){missing('dialogue',continuation.dialogue_id);continue;}ids.add(dialogue.character_id);dep.audio_continuation.push({speaker:master(resolver.asset(dialogue.character_id)),text:dialogue.text,source:dialogue.source,performance:dialogue.performance});}
  for(const id of ids){const asset=readAsset(id,'characters');if(asset){const info=characters.get(asset.id);if(info)dep.characters.push({id:asset.id,name:info.name,age:info.age,role:info.role,description:info.description,appearance:info.appearance,attribute_scores:info.attribute_scores});}}
  for(const item of view.shot_character_looks?.[shot.id]??[]){look(item.canonical_look_id);for(const id of item.image_binding_ids)image(id);}
  for(const reference of shotReferenceRows(project,shot,row.scene)){
   if(reference.look_id)look(reference.look_id);for(const key of bindingImageFields)if(reference[key])image(reference[key]);
   if(reference.asset_id){const file=fileIds.get(reference.asset_id);if(file){dep.references.push({id:file.id,data:Object.fromEntries(Object.entries(file).filter(([k])=>!['path','revision'].includes(k)))});if(!file.embedded_data)missing('legacy-file',file.id);}else image(reference.asset_id);}
   const subject=reference.creative_asset_id??reference.subject_id;if(subject&&subject!==row.scene.id&&!ids.has(subject))readAsset(subject,'references');
  }
  for(const id of shot.prop_ids??[])readAsset(id,'references');
  for(const id of new Set([shot.scene_asset_id,row.scene.scene_asset_id].filter(Boolean)))readAsset(id,'scene');
  if(view.dependencyError)missing('project',project.project_id);
  result[shot.id]=dep;
 }
 return result;
}
