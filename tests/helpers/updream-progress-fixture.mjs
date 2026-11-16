import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
export async function progressFixture(t){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'updream-progress-')));await fs.chmod(root,0o700);
 const queue=path.join(root,'queue'),jobs=path.join(queue,'jobs'),data=path.join(root,'data'),sources=path.join(root,'sources');
 for(const p of [queue,jobs,data,sources])await fs.mkdir(p,{mode:0o700});
 const project=randomUUID(),instance=randomUUID(),folder=randomUUID();
 async function put(id,patch={},statePatch={}){
  const source=path.join(sources,id+'.json');
  const q={version:1,task_id:id,stage:'monitoring',created:1700000000,target:{origin:'http://127.0.0.1:4317',project,folder:'合成片段',filename:id+'.mp4'},source,...patch};
  const state={name:'合成任务 '+id,count:1,original_prompt:'PRIVATE_PROMPT_MUST_NOT_LEAK',settings:{ratio:1.777},generation:{task_id:id,status:'processing',video_url:'https://example.invalid/?token=PRIVATE_SIGNED_URL'},...statePatch};
  const file=path.join(jobs,createHash('sha256').update(id).digest('hex')+'.json');
  await fs.writeFile(source,JSON.stringify(state),{mode:0o600});await fs.writeFile(file,JSON.stringify(q),{mode:0o600});return {q,state,file,source};
 }
 function delivered(id){return {stage:'ready',verified:true,target:{origin:'http://127.0.0.1:4317',instance,project,folder_id:folder,filename:id+'.mp4'},video_id:randomUUID(),prompt_id:randomUUID(),file:'/PRIVATE/RESULT/FILE.mp4',sha256:'a'.repeat(64)};}
 t?.after(()=>fs.rm(root,{recursive:true,force:true}));return {root,queue,jobs,data,sources,project,instance,folder,put,delivered};
}
