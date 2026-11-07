import * as domain from '../../server/storyboard/shared/model.mjs';
const M:any=domain;
export type VideoShotEdits=Record<string,Record<string,string>>;
export type VideoSaveRecord={revision:number;initializedAt:number;documentId:string;project:any};
export type VideoDetailBridge={project:any;edits:VideoShotEdits;dirty:boolean;onEdit:(shotId:string,field:string,value:string)=>void;onSave:()=>Promise<VideoSaveRecord>;onDiscard:()=>void};
export const videoTextFields=['framing','action','camera','sound','transition'] as const;
export function editVideoShot(project:any,edits:VideoShotEdits,shotId:string,field:string,value:string):VideoShotEdits {
 const shot=M.timeline(project).find((r:any)=>r.shot.id===shotId)?.shot;if(!shot)throw Error('镜头已不存在，原输入保留，请核对当前分镜');
 const original=field==='duration'?String(shot.duration_ms/1000):field.startsWith('dialogue:')?shot.dialogue.find((d:any)=>d.id===field.slice(9))?.text:shot[field];
 if(original===undefined||!(field==='duration'||videoTextFields.includes(field as any)||field.startsWith('dialogue:')))throw Error('不支持修改此镜头字段');
 const next={...edits,[shotId]:{...edits[shotId],[field]:value}};if(value===original)delete next[shotId][field];if(!Object.keys(next[shotId]).length)delete next[shotId];return next;
}
export function applyVideoShotEdits(project:any,edits:VideoShotEdits){
 const next=M.commitProject(project,(draft:any)=>{for(const [id,fields]of Object.entries(edits)){
  const shot=M.timeline(draft).find((r:any)=>r.shot.id===id)?.shot;if(!shot)throw Error('修改的镜头已不存在，请保留草稿并核对最新分镜');
  for(const [key,value]of Object.entries(fields)){
   if(key==='duration'){if(!/^\d+(?:\.\d{1,3})?$/.test(value.trim()))throw Error('时长须为正秒数，最多三位小数；原输入已保留');const ms=Math.round(Number(value)*1000);if(!Number.isSafeInteger(ms)||ms<1||ms>86400000)throw Error('时长须在0.001至86400秒之间；原输入已保留');shot.duration_ms=ms;}
   else if(videoTextFields.includes(key as any))shot[key]=value;
   else if(key.startsWith('dialogue:')){const d=shot.dialogue.find((v:any)=>v.id===key.slice(9));if(!d)throw Error('对白已变化，请保留草稿并核对');d.text=value;}
   else throw Error('镜头修改包含不支持的字段');
  }
 }});const errors=M.validateProject(next);if(errors.length)throw Error(errors.map((e:any)=>e.path+'：'+e.message).join('\n'));return next;
}
