import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {Receipts,error} from '../server/file-intake/files.mjs';
const run=promisify(execFile);
const fallbackMessage='无法读取所选素材或准备本机窗口，请在拾光文件任务中重新安装右键入口';

async function logPreparationFailure(receipts,failure,handoffId) {
  const {reason,code,stage,fileId}=failure.diagnostic??{reason:'unknown',code:null,stage:'prepare-handoff'};
  const line='[finder-intake] '+JSON.stringify({handoffId,stage,reason,code,fileId,receiptDiagnostic:failure.receiptDiagnostic})
    +' '+(failure.diagnostic?failure.message:fallbackMessage);
  console.error(line);
  // Automator may discard stderr. Keep one small, private log per failed
  // selection and leave the filename details in the private receipt only.
  const log=path.join(receipts.base,'handoffs',(handoffId??randomUUID())+'.failure.log');
  try {await fs.writeFile(log,line+'\n',{flag:constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,mode:0o600});}
  catch {console.error('[finder-intake] '+JSON.stringify({handoffId,stage:'write-diagnostic-log',reason:'无法保存核验日志'}));}
}

export async function readConfig(file) {
  const h=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const st=await h.stat();
    if(!st.isFile()||st.size>16384||st.uid!==process.getuid?.()||(st.mode&0o077))throw error('INTAKE_CONFIG_INVALID','右键入口配置不可用，请重新安装');
    const c=JSON.parse(await h.readFile('utf8'));
    if(c.format!==1||!['node','project','dataDir','helper','personalItemDirectory'].every(k=>typeof c[k]==='string'&&path.isAbsolute(c[k])))throw error('INTAKE_CONFIG_INVALID','右键入口配置无效');
    return c;
  }finally{await h.close();}
}
export async function running(dataDir) {
  try {
    const r=JSON.parse(await fs.readFile(path.join(dataDir,'server.json'),'utf8'));
    if(!Number.isSafeInteger(r.pid)||!Number.isSafeInteger(r.port)||r.port<1024||r.port>65535||r.url!==`http://127.0.0.1:${r.port}`)return null;
    process.kill(r.pid,0);
    const response=await fetch(r.url+'/api/session',{signal:AbortSignal.timeout(2000),redirect:'error'}),s=await response.json();
    return response.ok&&s.app==='shiguang-local-media'&&r.instanceId===s.instanceId?r:null;
  }catch{return null;}
}
export async function intake(config,files,{onWindow}={}) {
  const c=await readConfig(config),receipts=await new Receipts(c.dataDir).init();
  let handoff;
  try {handoff=await receipts.handoff(files,{deferFingerprint:true});}
  catch(e){if(e.diagnostic)await logPreparationFailure(receipts,e);throw e;}
  const controller=new AbortController();
  const preparation=receipts.prepareHandoff(handoff.id,{signal:controller.signal}).catch(e=>{
    if(e.diagnostic?.reason==='cancelled'&&controller.signal.aborted&&!e.receiptDiagnostic)return;
    return logPreparationFailure(receipts,e,handoff.id);
  });
  try {
  let current=await running(c.dataDir);
  if(!current) {
    let consent;
    try {consent=await run(c.helper,['--start-alert',handoff.id],{maxBuffer:8192});}
    catch(e){if(e.code===2)return {cancelled:true,handoffId:handoff.id};throw error('INTAKE_WINDOW_UNAVAILABLE','无法打开收纳窗口，请在拾光文件任务中重新安装右键入口');}
    let acknowledgement;
    try{acknowledgement=JSON.parse(consent.stdout);}catch{}
    if(acknowledgement?.action!=='start'||acknowledgement.handoffId!==handoff.id)
      throw error('INTAKE_START_NOT_CONFIRMED','没有取得本次选择的明确启动确认，未启动服务；请从访达重新打开');
    await run(c.node,[path.join(c.project,'scripts/launch.mjs')],{cwd:c.project,
      env:{...process.env,MEDIA_DATA_DIR:c.dataDir,MEDIA_PERSONAL_ITEM_DIR:c.personalItemDirectory},timeout:130000,maxBuffer:16384});
    current=await running(c.dataDir);
    if(!current)throw error('INTAKE_START_FAILED','素材服务尚未就绪。本次选择已保留，请启动拾光后重试');
  }
  const child=spawn(c.helper,['--url',current.url+'/#/file-intake/'+handoff.id],{detached:true,stdio:'ignore'});
  child.once('exit',()=>controller.abort());
  onWindow?.(child);
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
  await preparation;
  return {handoffId:handoff.id};
  } finally {controller.abort();await preparation;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [, , flag,config,separator,...files]=process.argv;
  if(flag!=='--config'||separator!=='--')throw Error('请从访达右键入口使用收纳素材');
  try {await intake(config,files);}catch(e) {
    const message=(e.diagnostic||e.status)?e.message:fallbackMessage;
    if(!e.diagnostic)console.error('收纳未开始：'+message);
    try {const c=await readConfig(config);await run(c.helper,['--error',message],{maxBuffer:8192});}catch{}
    process.exitCode=1;
  }
}
