#!/usr/bin/env node
// Local HTTP only. Session cookie/token stay in memory; no database or model access.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {schemaErrors,initializationErrors} from './validate.mjs';
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const digest=v=>createHash('sha256').update(canonical(v)).digest('hex');
const read=p=>fs.readFile(p,'utf8').then(JSON.parse);
const write=(p,v)=>fs.writeFile(p,JSON.stringify(v,null,2)+'\n',{mode:0o600,flag:'wx'});
const fail=(message,code='PUBLISH_REFUSED')=>{throw Object.assign(Error(message),{code});};
function localOrigin(value='http://127.0.0.1:4317'){
 const u=new URL(value);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)fail('只允许本机 127.0.0.1 的拾光服务地址');return u.origin;
}
class Api{
 constructor(origin){this.origin=localOrigin(origin);}
 async connect(expected){
  const r=await fetch(this.origin+'/api/session',{redirect:'error',signal:AbortSignal.timeout(10000)});if(!r.ok)fail('未取得拾光会话：HTTP '+r.status);
  const d=await r.json();if(d.app!=='shiguang-local-media'||!uuid.test(d.instanceId)||typeof d.token!=='string'||!d.token)fail('该端口不是可识别的拾光素材管理器');if(expected&&d.instanceId!==expected)fail('当前服务属于另一素材库，已停止提交','LIBRARY_CHANGED');
  this.instanceId=d.instanceId;this.token=d.token;this.cookie=r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');if(!this.cookie)fail('服务没有返回可用的本机会话');return this;
 }
 async call(method,url,body){
  const r=await fetch(this.origin+url,{method,redirect:'error',headers:{cookie:this.cookie,origin:this.origin,'x-local-token':this.token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});
  let d;try{d=await r.json();}catch{fail('业务接口未返回 JSON：HTTP '+r.status,'HTTP_UNVERIFIED');}if(!r.ok)throw Object.assign(Error(d.message||d.error||'HTTP '+r.status),{code:d.code||'HTTP_'+r.status,status:r.status,details:d.errors});return d;
 }
 async projects(){return(await this.call('GET','/api/projects')).filter(p=>p.project_kind==='normal');}
 async project(selector){const rows=await this.projects(),found=rows.filter(p=>p.id===selector||p.name.normalize('NFC')===String(selector).normalize('NFC'));if(found.length!==1)fail(found.length?'目标项目不唯一，请指定项目 ID':'没有精确匹配的普通项目，请先查看 projects，不按聊天目录猜测目标');return found[0];}
 async board(id){try{return await this.call('GET',`/api/storyboard/projects/${id}`);}catch(e){if(e.status===404)return null;throw e;}}
}
function fingerprint(board){return board?{revision:board.revision,documentId:board.project.document_id,initializedAt:board.initialized_at,assetStamp:board.asset_stamp,hash:board.hash}:null;}
function same(a,b){return canonical(a)===canonical(b);}
function stats(p){const scenes=p?.scenes??[],shots=scenes.flatMap(s=>s.shots??[]);return{scenes:scenes.length,shots:shots.length,duration_ms:shots.reduce((n,q)=>n+q.duration_ms,0)};}
function content(p){if(!p)return null;const q=structuredClone(p);delete q.revision;delete q.import_source;delete q.legacy_media_project_id;return q;}
function changes(a,b,prefix='',out=[]){
 if(same(a,b))return out;if(a&&b&&typeof a==='object'&&typeof b==='object'&&Array.isArray(a)===Array.isArray(b)){for(const k of new Set([...Object.keys(a),...Object.keys(b)]))changes(a[k],b[k],prefix+'/'+k.replaceAll('~','~0').replaceAll('/','~1'),out);}else out.push({path:prefix||'/',before:a??null,after:b??null});return out;
}
function validateEdit(p,current,id){
 if(!p||typeof p!=='object'||Array.isArray(p)||p.schema_version!=='1.0.0'||p.project_id!==current.project.project_id||p.document_id!==current.project.document_id||p.bound_project_id!==id)fail('日常更新须从 project.json 编辑，保留当前文档和项目永久 ID');
 if(!same(p.asset_manifest,current.project.asset_manifest)||!same(p.characters,current.project.characters)||!same(p.assets,current.project.assets))fail('本技能的日常更新保留人物与素材清单；变更清单需明确选择整套初始化流程');
 if(!same(p.import_source,current.project.import_source)||!same(p.legacy_media_project_id,current.project.legacy_media_project_id)||!same(p.generation_batches,[])||!same(p.generation_runs,[]))fail('日常保存不能替换导入来源或历史批次');
 if(!Array.isArray(p.scenes))fail('缺少 scenes 数组');const ids=new Set();const unique=(id,label)=>{if(typeof id!=='string'||!id||ids.has(id))fail(label+' 缺少永久 ID 或 ID 重复');ids.add(id);};
 for(const s of p.scenes){unique(s.id,'场次');if(!Array.isArray(s.shots))fail('场次缺少 shots 数组');for(const q of s.shots){unique(q.id,'镜头');if(!Number.isSafeInteger(q.duration_ms)||q.duration_ms<=0)fail('镜头时长必须是正整数毫秒');for(const d of q.dialogue??[])unique(d.id,'对白');}}
}
function validateScope(scope){if(scope?.format!=='shiguang-storyboard-session-v1'||!uuid.test(scope.projectId)||!uuid.test(scope.instanceId))fail('读取快照的项目绑定无效');localOrigin(scope.origin);}
async function currentFor(scope){validateScope(scope);const api=await new Api(scope.origin).connect(scope.instanceId);await api.project(scope.projectId);return{api,board:await api.board(scope.projectId)};}
async function exists(file){try{await fs.access(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function validateInput(value,mode,dir){const errors=schemaErrors(value,await read(path.join(dir,mode==='update'?'editor-schema.json':'initialization-schema.json')));if(!errors.length&&mode==='initialize')errors.push(...initializationErrors(value));if(errors.length)throw Object.assign(Error('分镜格式或引用/时间校验失败，未提交'),{code:'INPUT_INVALID',details:errors});}
async function verify(plan,api,response){
 const board=await api.board(plan.scope.projectId);if(!board)fail('提交后没有读到分镜','RESULT_UNVERIFIED');
 if(plan.mode==='update'){
  if(board.project.document_id!==plan.scope.base.documentId||board.initialized_at!==plan.scope.base.initializedAt||!same(content(board.project),content(plan.payload.project)))fail('最新内容与提交候选不完全一致；未自动重发','RESULT_UNVERIFIED');
  if(response&&(response.project_id!==plan.scope.projectId||response.revision!==board.revision||!same(content(response.project),content(board.project))))fail('保存回执与当前分镜不一致','RESULT_UNVERIFIED');
 }else{
  const receipt=response?.receipt;if(!receipt||receipt.request_id!==plan.payload.request_id||receipt.project_id!==plan.scope.projectId||receipt.document_id!==board.project.document_id||receipt.initialized_at!==board.initialized_at||receipt.revision!==board.revision)fail('初始化回执与当前分镜不一致，未自动重发','RESULT_UNVERIFIED');
  for(const k of ['scenes','shots','duration_ms'])if(stats(board.project)[k]!==plan.preview[k])fail('初始化回读数量/时长与预览不同','RESULT_UNVERIFIED');
 }
 return{status:'verified',projectId:plan.scope.projectId,projectName:plan.scope.projectName,documentId:board.project.document_id,revision:board.revision,...stats(board.project),observedAt:new Date().toISOString(),board};
}
function parse(argv){const [command,...args]=argv,options={};for(let i=0;i<args.length;i++){const key=args[i];if(!key.startsWith('--')||Object.hasOwn(options,key.slice(2)))fail('参数重复或格式无效：'+key);const flag=key.slice(2);options[flag]=['allow-write','replace-current'].includes(flag)?true:args[++i];if(options[flag]===undefined)fail('参数缺少值：'+key);}return{command,options};}
export async function main(argv){
 const {command,options:o}=parse(argv),allowed={projects:['origin'],read:['origin','project','target-file','remember','out'],prepare:['session','input','mode'],commit:['plan','allow-write','replace-current'],check:['plan']};
 if(!allowed[command])return{usage:'projects [--origin URL] | read --project 精确名称或ID [--remember FILE] [--out NEW_DIR] | read --target-file FILE | prepare --session DIR --input JSON --mode update|initialize | commit --plan DIR --allow-write [--replace-current] | check --plan DIR'};
 for(const k of Object.keys(o))if(!allowed[command].includes(k))fail('当前命令不支持 --'+k);
 if(command==='projects'){const api=await new Api(o.origin).connect();return{origin:api.origin,instanceId:api.instanceId,projects:(await api.projects()).map(p=>({id:p.id,name:p.name}))};}
 if(command==='read'){
  const target=o['target-file']?await read(o['target-file']):null;if(target&&(target.format!=='shiguang-storyboard-target-v1'||!uuid.test(target.projectId)||!uuid.test(target.instanceId)))fail('项目绑定文件无效');if(!o.project&&!target)fail('请指定精确项目，或提供已确认的 --target-file');if(target&&o.origin&&localOrigin(o.origin)!==target.origin)fail('地址与项目绑定不一致');
  const api=await new Api(target?.origin??o.origin).connect(target?.instanceId),p=await api.project(o.project??target.projectId);if(target&&p.id!==target.projectId)fail('目标与项目绑定不同，未切换项目');const board=await api.board(p.id),dir=o.out?path.resolve(o.out):await fs.mkdtemp(path.join(os.tmpdir(),'shiguang-storyboard-publish-'));if(o.out)await fs.mkdir(dir,{mode:0o700});await fs.chmod(dir,0o700);
  const scope={format:'shiguang-storyboard-session-v1',origin:api.origin,instanceId:api.instanceId,projectId:p.id,projectName:p.name,base:fingerprint(board)};
  await write(path.join(dir,'session.json'),scope);await write(path.join(dir,'current.json'),board);await write(path.join(dir,'project.json'),board?.project??null);await write(path.join(dir,'editor-schema.json'),await api.call('GET','/api/storyboard/schema'));await write(path.join(dir,'initialization-schema.json'),await api.call('GET','/api/storyboard/initialization-schema'));await write(path.join(dir,'example.json'),await api.call('GET','/api/storyboard/example'));
  if(o.remember){const binding={format:'shiguang-storyboard-target-v1',origin:api.origin,instanceId:api.instanceId,projectId:p.id,projectName:p.name};try{await write(path.resolve(o.remember),binding);}catch(e){if(e.code!=='EEXIST'||!same(await read(o.remember),binding))throw e;}}
  return{session:dir,projectId:p.id,projectName:p.name,initialized:!!board,revision:board?.revision??null,...stats(board?.project),files:['project.json','current.json','editor-schema.json','initialization-schema.json','example.json']};
 }
 if(command==='prepare'){
  if(!o.session||!o.input||!['update','initialize'].includes(o.mode))fail('prepare 需要 --session、--input 和 --mode update|initialize');const dir=path.resolve(o.session),scope=await read(path.join(dir,'session.json')),baseline=await read(path.join(dir,'current.json')),raw=await read(o.input),{api,board}=await currentFor(scope);if(!same(scope.base,fingerprint(board)))fail('分镜或关联资产已更新，请重新读取并合并，不覆盖新版本','VERSION_CONFLICT');
  let payload,preview=null;if(o.mode==='update'){if(!board)fail('目标项目尚未初始化，请使用 initialize');const project=raw.project??raw;await validateInput(project,'update',dir);validateEdit(project,board,scope.projectId);payload={project,expected_revision:board.revision,asset_stamp:board.asset_stamp};}else{await validateInput(raw,'initialize',dir);payload={source:raw,expected_revision:board?.revision??null,request_id:randomUUID(),filename:path.basename(o.input),timing:'duration'};preview=await api.call('POST',`/api/storyboard/projects/${scope.projectId}/preview`,payload);if(preview.expected_revision!==payload.expected_revision)fail('预览期间分镜已更新','VERSION_CONFLICT');}
  const planDir=await fs.mkdtemp(path.join(dir,'plan-')),delta=o.mode==='update'?changes(content(baseline.project),content(payload.project)):null,plan={format:'shiguang-storyboard-plan-v1',scope,mode:o.mode,payload,payloadSha256:digest(payload),preview,createdAt:new Date().toISOString()};await write(path.join(planDir,'plan.json'),plan);await write(path.join(planDir,'before.json'),baseline);await write(path.join(planDir,'diff.json'),delta??{reinitialize:true,preview});return{plan:planDir,projectId:scope.projectId,projectName:scope.projectName,mode:o.mode,replacing:!!board&&o.mode==='initialize',changeCount:delta?.length,changes:delta?.slice(0,40),fullDiff:path.join(planDir,'diff.json'),preview,commitRequires:'用户明确要求提交；若已有分镜整套覆盖，还须明确覆盖授权。读取和prepare本身不修改分镜。'};
 }
 if(!o.plan)fail('需要 --plan DIR');const dir=path.resolve(o.plan),plan=await read(path.join(dir,'plan.json'));if(plan.format!=='shiguang-storyboard-plan-v1'||!same(digest(plan.payload),plan.payloadSha256))fail('计划内容或摘要已变化，未提交');validateScope(plan.scope);if(!['update','initialize'].includes(plan.mode)||plan.mode==='initialize'&&!uuid.test(plan.payload.request_id))fail('计划目标或模式无效');
 if(command==='check'){
  const {api}=await currentFor(plan.scope);let response=null;if(plan.mode==='initialize'){response=await api.call('GET',`/api/storyboard/projects/${plan.scope.projectId}/requests/${plan.payload.request_id}`);if(response.completed!==true)return{status:'not_found_not_resent',message:'未查到原初始化回执，没有重新发送'};}
  else if(await exists(path.join(dir,'response.json')))response=await read(path.join(dir,'response.json'));
  try{const verified=await verify(plan,api,response),result={...verified,...(plan.mode==='update'&&!response?{status:'current_matches_submission_unconfirmed',message:'当前内容匹配，但没有原保存回执，不能证明由本计划写入；没有重新发送'}:{message:'仅核对原回执与当前内容，没有重发保存'}),checkOnly:true};await write(path.join(dir,'checked-'+randomUUID()+'.json'),result);const{board,...summary}=result;return summary;}catch(e){return{status:'unverified_not_resent',message:e.message};}
 }
 if(!o['allow-write'])fail('commit 需要 --allow-write，只在用户已明确要求提交时使用');if(plan.mode==='initialize'&&plan.scope.base&&!o['replace-current'])fail('目标已有分镜，完整覆盖还需要 --replace-current；普通更新应使用 update');
 if(await exists(path.join(dir,'result.json'))){const previous=await read(path.join(dir,'result.json'));return{status:'already_submitted',previousReceipt:previous,message:'本计划之前已核实提交成功，本次没有重发；如需核对当前版本请使用 check'};}
 if(await exists(path.join(dir,'sending.json')))fail('本计划已发送或发送结果待核对，请使用 check，不能重新发送','CHECK_REQUIRED');
 const {api,board}=await currentFor(plan.scope);if(!same(fingerprint(board),plan.scope.base))fail('分镜/资产或初始化代次已变化，未提交；请重新读取','VERSION_CONFLICT');if(plan.mode==='update')validateEdit(plan.payload.project,board,plan.scope.projectId);
 try{await write(path.join(dir,'sending.json'),{at:new Date().toISOString(),projectId:plan.scope.projectId,payloadSha256:plan.payloadSha256});}catch(e){if(e.code==='EEXIST')fail('本计划已发送或发送结果待核对，请使用 check，不能重新发送','CHECK_REQUIRED');throw e;}
 let response;try{
  response=await api.call(plan.mode==='update'?'PUT':'POST',`/api/storyboard/projects/${plan.scope.projectId}`+(plan.mode==='initialize'?'/initialize':''),plan.payload);await write(path.join(dir,'response.json'),response);const result=await verify(plan,api,response);await write(path.join(dir,'readback.json'),result.board);const{board:_,...summary}=result;await write(path.join(dir,'result.json'),summary);return summary;
 }catch(e){await write(path.join(dir,'unverified.json'),{status:'unverified_not_resent',message:e.message,code:e.code??'NETWORK_ERROR',httpStatus:e.status??null,at:new Date().toISOString(),checkCommand:['check','--plan',dir]});throw e;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main(process.argv.slice(2)).then(v=>console.log(JSON.stringify(v,null,2))).catch(e=>{console.error(JSON.stringify({error:e.message,code:e.code??'PUBLISH_ERROR',details:e.details},null,2));process.exitCode=1;});
