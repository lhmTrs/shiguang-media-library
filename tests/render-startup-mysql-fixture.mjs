import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import mysql from 'mysql2/promise';
import net from 'node:net';

export async function bounded(promise, ms, label) {
 let timer;
 try { return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms);})]); }
 finally {clearTimeout(timer);}
}

// An owned socket-only server. Never discovers an existing server or reads its defaults.
export async function ownedRenderMysql({tcp=false}={}) {
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'render-startup-mysql-')));
 await fs.chmod(root,0o700);
 let port;
 if(tcp){const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));port=listener.address().port;await new Promise(r=>listener.close(r));}
 const data=path.join(root,'data');await fs.mkdir(data,{mode:0o700});
 const binary=process.env.RENDER_TEST_MYSQLD||'/usr/local/mysql/bin/mysqld';
 let logs='',server,control,exited,initializer,initializerExit;let overflow=false;
 const capture=child=>{const append=v=>{if(Buffer.byteLength(logs)+v.length<=1048576)logs+=v;else overflow=true;};child.stdout.on('data',append);child.stderr.on('data',append);};
 const config={socketPath:path.join(root,'mysql.sock'),user:'root',password:'',connectTimeout:1000};
 const inventory={root,serverPid:null,version:null,shutdown:'NOT_STARTED',checks:[]};
 async function save(){await fs.writeFile(path.join(root,'mysql.log'),logs,{mode:0o600});await fs.writeFile(path.join(root,'evidence.json'),JSON.stringify(inventory,null,2),{mode:0o600});}
 try {
  initializer=spawn(binary,['--no-defaults','--initialize-insecure','--datadir='+data],{stdio:['ignore','pipe','pipe']});capture(initializer);initializerExit=once(initializer,'exit');
  const [code]=await bounded(initializerExit,30000,'owned MySQL initialization timed out');
  if(code!==0)throw Error('owned MySQL initialization failed');
  server=spawn(binary,['--no-defaults','--datadir='+data,...(tcp?['--port='+port,'--bind-address=127.0.0.1']:['--skip-networking']),'--mysqlx=OFF','--socket='+config.socketPath,'--pid-file='+path.join(root,'mysql.pid')],{stdio:['ignore','pipe','pipe']});capture(server);inventory.serverPid=server.pid;exited=once(server,'exit');
  for(let i=0;i<100;i++){
   if(server.exitCode!==null)throw Error('owned MySQL exited before ready');
   try{control=await mysql.createConnection(config);break;}catch{await new Promise(r=>setTimeout(r,100));}
  }
  if(!control)throw Error('owned MySQL did not become ready');
  const [[row]]=await control.query('SELECT VERSION() version,@@server_uuid uuid,@@datadir dataDir,@@pid_file pidFile,@@socket socket,@@port port,@@bind_address bindAddress');inventory.version=row.version;inventory.identity=row;if(await fs.realpath(row.dataDir)!==await fs.realpath(data)||row.socket!==config.socketPath||tcp&&(Number(row.port)!==port||row.bindAddress!=='127.0.0.1')||Number((await fs.readFile(row.pidFile,'utf8')).trim())!==server.pid||overflow)throw Error('owned MySQL identity/log boundary failed');
  await control.query('CREATE DATABASE render_upgrade_test CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');
  return {root,inventory,tcpConfig:tcp?{host:'127.0.0.1',port,user:'root',password:'',database:'render_app_test'}:null,config:{...config,database:'render_upgrade_test'},async connect(){return mysql.createConnection({...config,database:'render_upgrade_test'});},async close(){
   inventory.shutdown='REQUESTED';
   try{await control.query('SHUTDOWN');}catch(e){if(!['PROTOCOL_CONNECTION_LOST','ECONNRESET'].includes(e.code))throw e;}
   const [exitCode,signal]=await bounded(exited,15000,'owned MySQL shutdown unconfirmed');
   if(exitCode!==0||signal)throw Error('owned MySQL did not exit normally');
   inventory.shutdown='NORMAL_EXIT_CONFIRMED';await control.end().catch(()=>{});await save();
  },save};
 }catch(error){
  for(const [name,child,exit]of [['initializer',initializer,initializerExit],['server',server,exited]]){
   if(!child)continue;
   if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');try{const [code,signal]=await bounded(exit,15000,'owned startup cleanup unknown');inventory[name+'Cleanup']={code,signal};}catch{inventory[name+'Cleanup']={unknown:true,pid:child.pid};child.unref();child.stdout.unref?.();child.stderr.unref?.();}}
  }
  inventory.shutdown=server?.exitCode===null&&server?.signalCode===null||initializer?.exitCode===null&&initializer?.signalCode===null?'RETAINED_STARTUP_UNCERTAIN':'NOT_RUNNING';await save();throw Object.assign(error,{evidenceRoot:root});
 }
}
