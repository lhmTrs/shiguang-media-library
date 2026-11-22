import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dataDirectory} from '../server/runtime.mjs';
import {readShutdownReceipt} from '../server/application-shutdown.mjs';
import {createShutdownClient} from './shutdown-client.mjs';
export async function stopWindows(){
 if(process.platform!=='win32')throw Error('WINDOWS_ONLY');
 try{
  const project=fileURLToPath(new URL('..',import.meta.url)),data=await fs.realpath(dataDirectory(project,{...process.env,MEDIA_PORTABLE:'1'})),file=path.join(data,'server.json');
  const named=await fs.lstat(file);if(!named.isFile()||named.isSymbolicLink()||named.nlink!==1||named.size>8192||await fs.realpath(file)!==file)throw Error('RUN_RECORD_UNSAFE');
  const h=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));let record;
  try{const before=await h.stat();if(before.ino!==named.ino||before.dev!==named.dev||before.size!==named.size)throw Error('RUN_RECORD_UNSAFE');record=JSON.parse(await h.readFile('utf8'));}finally{await h.close();}
  if(!/^shutdown-[A-Za-z0-9_-]+$/.test(record.receiptDirectory||''))throw Error('RECEIPT_IDENTITY_UNAVAILABLE');
  const root=path.join(data,record.receiptDirectory),client=createShutdownClient({budgetMs:30000,readReceipt:()=>readShutdownReceipt(root)});
  const result=await client.stop({url:record.url,libraryId:record.instanceId,runId:record.runId,requestId:randomUUID()});
  if(result.phase!=='CLOSED_KNOWN')throw Error('SHUTDOWN_UNCONFIRMED');
  console.log('分享版服务已正常停止，数据保留。');return result;
 }catch{console.error('未能确认服务已安全停止，请保留运行记录并核对；未强制终止任何进程。');process.exitCode=1;return{phase:'UNKNOWN',code:'SHUTDOWN_UNCONFIRMED'};}
}
