import {randomUUID} from 'node:crypto';
import {fault} from '../project-assets/model.mjs';
import {safeText,taskPageOptions,taskCursor} from '../prompt-codex/tasks.mjs';
const busy=()=>fault('其他Codex任务仍未结清，请先核对任务状态',423,{code:'CODEX_BUSY'});
// Decorate the existing owner, never create a second untracked Codex process.
// Original task-drawer source files remain byte-for-byte untouched.
export function attachGenerationTasks(codex,generation){
 const external=generation.owners,normal=codex.tasks;
 const owners=()=>[...normal.values(),...external.values()];
 const prior={};for(const name of ['status','connect','disconnect','start','cohort','stopImpact','stopTask','terminateOwnedClient','close','taskOverview'])prior[name]=codex[name].bind(codex);
 codex.cohort=client=>owners().filter(t=>t.client===client).map(t=>t.id).sort();
 codex.status=()=>({...prior.status(),active:owners().length});
 codex.connect=async()=>{if(external.size)throw busy();return prior.connect();};
 codex.disconnect=async()=>{if(external.size)throw busy();return prior.disconnect();};
 codex.start=async(id,input)=>{if(typeof input?.id==='string'&&generation.store.db.prepare('SELECT id FROM sb_generation_tasks WHERE id=?').get(input.id))throw fault('请求编号已用于分镜生成任务',409,{code:'REQUEST_ID_CONFLICT'});if(owners().length>=4&&!normal.has(input?.id))throw fault('最多同时生成四个Codex任务',429);return prior.start(id,input);};
 codex.stopImpact=id=>{
  if(!external.has(id)){try{return prior.stopImpact(id);}catch(e){if(e.status!==404)throw e;generation.store.head(id);return{taskId:id,requiresConfirmation:false,otherTasks:[],impactToken:null,expiresAt:Date.now()};}}
  const task=external.get(id),ids=codex.cohort(task.client),now=Date.now();for(const [key,grant]of codex.impactTokens)if(grant.expiresAt<=now)codex.impactTokens.delete(key);while(codex.impactTokens.size>=128)codex.impactTokens.delete(codex.impactTokens.keys().next().value);
  const impactToken=randomUUID(),expiresAt=now+30000;codex.impactTokens.set(impactToken,{taskId:id,client:task.client,ids,expiresAt});
  const otherTasks=ids.filter(x=>x!==id).map(x=>{const ext=external.get(x);if(ext){const row=generation.store.dto(generation.store.display(x));return{taskId:x,conversationId:null,title:row.project.name+' · 分镜生成',status:row.status};}const t=normal.get(x),head=codex.store.db.prepare('SELECT title FROM codex_conversations WHERE id=?').get(t.conversationId);return{taskId:x,conversationId:t.conversationId,title:safeText(head?.title,200),status:codex.store.taskHead(x).status};});
  return{taskId:id,requiresConfirmation:otherTasks.length>0,otherTasks,impactToken,expiresAt};
 };
 // Existing normal stopImpact has normal-task metadata lookup. Supply the same
 // capability construction for a normal target when external peers are present.
 const mixedImpact=codex.stopImpact;
 codex.stopImpact=id=>{if(!normal.has(id)||!external.size)return mixedImpact(id);const target=normal.get(id),token=randomUUID(),ids=codex.cohort(target.client),expiresAt=Date.now()+30000;
  while(codex.impactTokens.size>=128)codex.impactTokens.delete(codex.impactTokens.keys().next().value);codex.impactTokens.set(token,{taskId:id,client:target.client,ids,expiresAt});
  const otherTasks=ids.filter(x=>x!==id).map(x=>{if(external.has(x)){const d=generation.store.dto(generation.store.display(x));return{taskId:x,conversationId:null,title:d.project.name+' · 分镜生成',status:d.status};}const task=normal.get(x),h=codex.store.db.prepare('SELECT title FROM codex_conversations WHERE id=?').get(task.conversationId);return{taskId:x,conversationId:task.conversationId,title:safeText(h?.title,200),status:codex.store.taskHead(x).status};});
  return{taskId:id,requiresConfirmation:otherTasks.length>0,otherTasks,impactToken:token,expiresAt};};
 codex.stopTask=async(id,options)=>{if(external.has(id))return generation.stop(id,options);try{return await prior.stopTask(id,options);}catch(e){if(e.status!==404)throw e;return generation.store.dto(generation.store.display(id));}};
 codex.terminateOwnedClient=async(reason,grant)=>{if(grant)codex.checkStopGrant(grant);for(const task of external.values())if(task.client===codex.client)task.stopReason=task.stopReason||(reason==='USER_STOPPED'&&grant?.taskId!==task.id?'SHARED_CONNECTION_CLOSED':reason);return prior.terminateOwnedClient(reason,grant);};
 codex.taskOverview=options=>{const page=prior.taskOverview(options),extra=generation.store.overview(options),{limit}=taskPageOptions(options),items=[...page.items,...extra.items],active=items.filter(i=>['queued','running','stopping'].includes(i.status)),terminal=items.filter(i=>!['queued','running','stopping'].includes(i.status)).sort((a,b)=>b.createdAt-a.createdAt||(a.taskId<b.taskId?1:a.taskId>b.taskId?-1:0)),recent=terminal.slice(0,limit),hasMore=terminal.length>limit||!!page.nextCursor||!!extra.nextCursor;
  return{...page,connection:{...page.connection,active:owners().length},activeCount:page.activeCount+extra.activeCount,items:[...active,...recent],nextCursor:hasMore&&recent.length?taskCursor({id:recent.at(-1).taskId,created_at:recent.at(-1).createdAt}):null,historyScope:{...page.historyScope,hasMore}};};
 codex.close=async()=>{generation.beginClose();await prior.close();await generation.close();};
 return owners;
}
