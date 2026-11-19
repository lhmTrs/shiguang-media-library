import {idOK} from '../project-assets/model.mjs';
import {canonical,fail} from './model.mjs';
const shotId=id=>typeof id==='string'&&id.trim().length>0&&id.length<=160&&!id.includes('\0');
export function unbindRefs(affected){
 return affected.map(row=>{
  if(row.id!==undefined&&row.shotId!==undefined&&row.id!==row.shotId)fail('VIDEO_BINDING_CONFLICT','预览镜头身份不一致',409);
  const ref={projectId:row.projectId,shotId:row.shotId??row.id};if(!idOK(ref.projectId)||!shotId(ref.shotId))fail('VIDEO_BINDING_CONFLICT','预览缺少明确的目标集或镜头身份',409);return ref;
 });
}
export function confirmUnbind(input,affected,{invalidCode='VIDEO_V2_INVALID_INPUT',missingCode='UNBIND_CONFIRMATION_REQUIRED',requireConfirmation=false}={}){
 const hasRefs=Object.hasOwn(input,'confirmedUnbindShotRefs')&&input.confirmedUnbindShotRefs!==undefined,hasIds=Object.hasOwn(input,'confirmedUnbindShotIds')&&input.confirmedUnbindShotIds!==undefined;
 if(hasRefs&&hasIds)fail(invalidCode,'复合镜头确认与旧镜头ID确认不能同时提交');
 const expected=unbindRefs(affected),key=ref=>canonical([ref.projectId,ref.shotId]);let supplied;
 if(hasRefs){const values=input.confirmedUnbindShotRefs;if(!Array.isArray(values)||values.some(v=>!v||Object.keys(v).sort().join(',')!=='projectId,shotId'||!idOK(v.projectId)||!shotId(v.shotId))||new Set(values.map(key)).size!==values.length)fail(invalidCode,'复合解除确认须含不重复且有效的目标集和镜头ID');supplied=values.map(key).sort();}
 if(hasIds){const values=input.confirmedUnbindShotIds;if(!Array.isArray(values)||values.some(id=>!shotId(id))||new Set(values).size!==values.length)fail(invalidCode,'旧镜头确认须为不重复的有效ID数组');
  if(new Set(expected.map(ref=>ref.shotId)).size!==expected.length)fail('VIDEO_UNBIND_SCOPE_REQUIRED','跨集同ID镜头须使用复合引用完整确认',409,{requiredShotRefs:expected});
  supplied=[...values].sort();
 }
 if(!expected.length){if(requireConfirmation&&(input.confirmUnbind!==true||supplied===undefined))fail(missingCode,'请明确确认完整解除集合，当前没有采用时仍须提供空集合',409);if(supplied?.length)fail(missingCode,'当前没有可解除的采用，确认集合已过期',409);return;}
 const wanted=hasIds?expected.map(r=>r.shotId).sort():expected.map(key).sort();
 if(input.confirmUnbind!==true||!supplied||canonical(supplied)!==canonical(wanted))fail(missingCode,'请确认完整且精确的采用解除集合',409,{requiredShotRefs:expected});
}
