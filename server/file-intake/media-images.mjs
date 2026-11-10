import {blankAsset, canonical, digest, idOK, nameKey} from '../project-assets/model.mjs';
import {error} from './files.mjs';

const label = (value,what) => {
  if(typeof value!=='string' || !value.trim() || value.trim().length>120 || /[\x00-\x1f\x7f]/.test(value))
    throw error('INVALID_IMAGE_TARGET',what+'无效',400);
  return value.trim().normalize('NFC');
};
export const allocatedId = key => {
  const h=digest('managed-intake-v1:'+key).slice(0,32);
  return [h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-');
};

// A proposal is read-only. In particular this never creates a character/look,
// and an archived name is not an implicit request to restore its old identity.
export function imageProposal(owner,projectId,name,lookName) {
  owner.project(projectId,true);
  const characterName=label(name,'人物名称'), requestedLook=label(lookName,'造型名称');
  const rows=owner.db.prepare('SELECT id FROM creative_assets WHERE project_id=? AND kind=? AND name_key=? AND archived_at=0').all(projectId,'character',nameKey(characterName));
  if(rows.length>1) throw error('IMAGE_TARGET_CONFLICT','同名人物不唯一，请明确选择编号');
  const a=rows[0] && owner.assets.get(rows[0].id);
  const looks=a?.looks.filter(l=>l.archived_at===null && nameKey(l.name)===nameKey(requestedLook)) || [];
  if(looks.length>1) throw error('IMAGE_TARGET_CONFLICT','同名造型不唯一，请明确选择编号');
  const l=looks[0];
  return {projectId,characterId:a?.id??null,characterRevision:a?.revision??null,lookId:l?.id??null,lookRevision:l?.revision??null,
    newCharacter:!a,newLook:!l,characterName:a?.name??characterName,lookName:l?.name??requestedLook};
}

export function normalizeProposal(projectId,p) {
  if(!p || p.projectId!==projectId || typeof p.newCharacter!=='boolean' || typeof p.newLook!=='boolean')
    throw error('IMAGE_PROPOSAL_REQUIRED','请先核对人物、造型的新建或既有编号与版本',400);
  const pair=(fresh,id,revision)=>fresh ? id===null && revision===null : idOK(id) && Number.isSafeInteger(revision) && revision>0;
  if(!pair(p.newCharacter,p.characterId,p.characterRevision) || !pair(p.newLook,p.lookId,p.lookRevision) || p.newCharacter&&!p.newLook)
    throw error('INVALID_IMAGE_TARGET','人物与造型的编号或版本不完整',400);
  return {projectId,characterId:p.characterId,characterRevision:p.characterRevision,lookId:p.lookId,lookRevision:p.lookRevision,
    newCharacter:p.newCharacter,newLook:p.newLook,characterName:label(p.characterName,'人物名称'),lookName:label(p.lookName,'造型名称')};
}

export function imageAllocation(proposal,group) {
  const characterId=proposal.characterId || allocatedId(canonical([group,proposal.projectId,'character',nameKey(proposal.characterName)]));
  return {characterId,lookId:proposal.lookId || allocatedId(canonical([group,proposal.projectId,characterId,'look',nameKey(proposal.lookName)]))};
}

// Only the exact ID allocated for this group may advance from "new" to existing.
// A full post-write snapshot proves revisions advanced by our own group; no name
// lookup ever claims an asset created by another request or an UNKNOWN attempt.
export function imageGuard(owner,target,{lock=false}={}) {
  const p=target.destination.imageProposal, ids=target.imageIds;
  owner.project(p.projectId,true);
  const row=owner.db.prepare('SELECT * FROM creative_assets WHERE id=?'+(lock?owner.assets.lock():'' )).get(ids.characterId);
  const a=row && owner.assets.get(ids.characterId);
  const own=a && owner.groupOwns(target.requestGroupId,a);
  if(a) {
    if(a.project_id!==p.projectId || a.kind!=='character' || a.archived_at || a.name!==p.characterName ||
        (p.newCharacter ? !own : a.revision!==p.characterRevision && !own))
      throw error('IMAGE_TARGET_CONFLICT','人物已归档、编辑或创建来源不符，请重新核对');
  } else if(!p.newCharacter) throw error('IMAGE_TARGET_CONFLICT','原人物已不存在');
  const names=owner.db.prepare('SELECT id FROM creative_assets WHERE project_id=? AND kind=? AND name_key=? AND archived_at=0').all(p.projectId,'character',nameKey(p.characterName));
  if(names.some(r=>r.id!==ids.characterId)) throw error('IMAGE_TARGET_CONFLICT','其他请求已创建同名人物，未自动认领');
  const l=a?.looks.find(l=>l.id===ids.lookId);
  if(l && (l.archived_at!==null || l.name!==p.lookName || (p.newLook ? !own : l.revision!==p.lookRevision && !own)))
    throw error('IMAGE_TARGET_CONFLICT','造型已归档、编辑或创建来源不符，请重新核对');
  if(!l && !p.newLook) throw error('IMAGE_TARGET_CONFLICT','原造型已不存在');
  if(a?.looks.some(l=>l.archived_at===null && nameKey(l.name)===nameKey(p.lookName) && l.id!==ids.lookId))
    throw error('IMAGE_TARGET_CONFLICT','其他请求已创建同名造型，未自动认领');
  return a;
}

export function bindingInput(target,previous,mediaId,bindingId) {
  const p=target.destination.imageProposal, ids=target.imageIds;
  const a=previous?structuredClone(previous):{...blankAsset(p.projectId,'character',p.characterName),id:ids.characterId};
  let look=a.looks.find(l=>l.id===ids.lookId);
  if(!look) {look={id:ids.lookId,name:p.lookName,tags:[],description:'',default_image_id:null,archived_at:null};a.looks.push(look);}
  a.default_look_id ??= ids.lookId;
  a.images.push({id:bindingId,look_id:ids.lookId,media_asset_id:mediaId,reference_type:'',purpose:'',locks:'',ignores:'',confirmed:false,
    crop:{x:50,y:50,zoom:1},archived_at:null});
  look.default_image_id ??= bindingId;
  return a;
}
