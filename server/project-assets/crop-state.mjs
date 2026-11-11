import {fault} from './model.mjs';

export const defaultCrop=c=>c.x===50&&c.y===50&&c.zoom===1;
const sameCrop=(a,b)=>a.x===b.x&&a.y===b.y&&a.zoom===b.zoom;
const origins=new Set([null,'untouched','manual','auto']);
export const cardBinding=asset=>asset?.kind==='character'&&!asset.archived_at?
  asset.looks.find(l=>l.id===asset.default_look_id&&l.archived_at===null)?.default_image_id??null:null;

export function cropState(binding,old,{copy=false}={}){
  const prior=old?.crop_source??null,hasOrigin=Object.hasOwn(binding,'crop_source'),asked=binding.crop_source;
  if(hasOrigin&&!origins.has(asked))throw fault('头像裁切来源无效');
  if(copy)return {crop_source:asked??null,crop_manually_edited:binding.crop_manually_edited===true||asked==='manual'};
  const edited=old?.crop_manually_edited===true||prior==='manual';
  let source;
  if(!old)source=asked==='auto'?'auto':asked==='manual'||!defaultCrop(binding.crop)?'manual':'untouched';
  else if(asked==='manual'||asked==='auto')source=asked;
  else if(prior!==null&&hasOrigin&&asked===null)source=null;
  else if(prior!==null&&prior!=='untouched'&&asked==='untouched'&&defaultCrop(binding.crop))source='untouched';
  else if(!sameCrop(binding.crop,old.crop))source='manual';
  else source=prior;
  return {crop_source:source,crop_manually_edited:edited||source==='manual'};
}
