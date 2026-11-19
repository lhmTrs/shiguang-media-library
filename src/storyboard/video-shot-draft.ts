import * as domain from '../../server/storyboard/shared/model.mjs';
const M:any=domain;
// 旧视频预览窗已移除。这里只用于恢复升级前留在浏览器里的预览输入草稿，避免用户输入丢失。
export type VideoShotEdits=Record<string,Record<string,string>>;
const videoTextFields=['framing','action','camera','sound','transition'];
export function applyVideoShotEdits(project:any,edits:VideoShotEdits){
 const next=M.commitProject(project,(draft:any)=>{for(const [id,fields]of Object.entries(edits)){
  const shot=M.timeline(draft).find((r:any)=>r.shot.id===id)?.shot;if(!shot)throw Error('修改的镜头已不存在，请保留草稿并核对最新分镜');
  for(const [key,value]of Object.entries(fields)){
   if(key==='duration'){if(!/^\d+(?:\.\d{1,3})?$/.test(value.trim()))throw Error('时长须为正秒数，最多三位小数；原输入已保留');const ms=Math.round(Number(value)*1000);if(!Number.isSafeInteger(ms)||ms<1||ms>86400000)throw Error('时长须在0.001至86400秒之间；原输入已保留');shot.duration_ms=ms;}
   else if(videoTextFields.includes(key))shot[key]=value;
   else if(key.startsWith('dialogue:')){const d=shot.dialogue.find((v:any)=>v.id===key.slice(9));if(!d)throw Error('对白已变化，请保留草稿并核对');d.text=value;}
   else throw Error('镜头修改包含不支持的字段');
  }
 }});const errors=M.validateProject(next);if(errors.length)throw Error(errors.map((e:any)=>e.path+'：'+e.message).join('\n'));return next;
}
