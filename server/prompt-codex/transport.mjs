import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';

export function codexError(code, message, status=503) {
  return Object.assign(Error(message), {code,status});
}
export async function findCodex() {
  if (process.env.MEDIA_CODEX_BIN) return process.env.MEDIA_CODEX_BIN;
  const names = process.platform==='win32'?['codex.exe','codex.cmd']:['codex'];
  const candidates = (process.env.PATH||'').split(path.delimiter).flatMap(dir=>names.map(name=>path.join(dir,name)));
  if (process.platform==='darwin') candidates.push(
    '/Applications/Codex.app/Contents/Resources/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  );
  for (const file of candidates) {try {if((await fs.stat(file)).isFile()) return file;} catch {}}
  throw codexError('CODEX_NOT_INSTALLED','未找到 Codex。请先安装并登录 Codex，然后重新连接。');
}

// JSON-RPC over private stdio. No public listener, token parsing or shell interpolation.
export class CodexTransport extends EventEmitter {
  constructor({cwd, command, args, timeoutMs=20000, spawnImpl=spawn,experimentalApi=false,clientInfo}={}) {
    super();this.cwd=cwd;this.command=command;this.args=args;this.timeoutMs=timeoutMs;
    this.spawnImpl=spawnImpl;this.pending=new Map();this.next=0;this.buffer='';this.closed=true;
    this.experimentalApi=experimentalApi;this.clientInfo=clientInfo;
  }
  async start() {
    if (this.child&&!this.closed) return;
    const command=this.command||await findCodex();this.commandResolved=command;this.commandIdentity=await fs.stat(command).then(s=>({size:s.size,mtimeMs:s.mtimeMs})).catch(()=>null);
    if (/\.cmd$/i.test(command)) throw codexError('CODEX_NATIVE_BINARY_REQUIRED','请配置原生 Codex 可执行文件；当前集成不通过 shell 启动 .cmd。');
    this.closed=false;
    // Disable command execution, patching, external MCPs and agents for this text/image client.
    const args=this.args||['app-server','--listen','stdio://',
      '-c','features.shell_tool=false','-c','features.apply_patch_freeform=false',
      '-c','features.multi_agent=false','-c','features.apps=false','-c','mcp_servers={}',
      '-c','approval_policy="never"','-c','sandbox_mode="read-only"'];
    const child=this.spawnImpl(command,args,{cwd:this.cwd,env:{...process.env},stdio:['pipe','pipe','pipe'],windowsHide:true});
    this.child=child;this.exit=new Promise(resolve=>{child.once('exit',(code,signal)=>{this.failAll(codexError('CODEX_DISCONNECTED','Codex 连接已关闭，已保留收到的内容。'));this.emit('closed',{code,signal});resolve();});child.once('error',()=>resolve());});
    child.on('error',()=>{this.failAll(codexError('CODEX_START_FAILED','Codex 启动失败，请检查安装与本机登录。'));});
    child.stdout.setEncoding('utf8');child.stdout.on('data',data=>this.receive(data));
    child.stderr.on('data',()=>{}); // Drain without retaining possible auth/runtime diagnostics.
    child.stdin.on('error',()=>{});
    await this.call('initialize',{clientInfo:this.clientInfo||{name:'shiguang_prompt_templates',title:'拾光提示词工作台',version:'1.0.0'},capabilities:{experimentalApi:this.experimentalApi,requestAttestation:false}});
    this.notify('initialized',{});
  }
  write(packet) {if(this.closed||!this.child?.stdin.writable)throw codexError('CODEX_DISCONNECTED','Codex 尚未连接');this.child.stdin.write(JSON.stringify(packet)+'\n');}
  notify(method,params) {this.write({method,params});}
  call(method,params={}) {
    if(this.closed)return Promise.reject(codexError('CODEX_DISCONNECTED','请先连接 Codex'));
    const id=++this.next;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(codexError('CODEX_RPC_TIMEOUT','Codex 响应超时。生成请求不会自动重试，请先核对任务状态。'));},this.timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      try{this.write({id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}
    });
  }
  receive(data) {
    this.buffer+=data;
    if(Buffer.byteLength(this.buffer)>90*1024*1024){this.failAll(codexError('CODEX_RESPONSE_TOO_LARGE','Codex 返回内容过大，连接已停止。'));this.child?.kill('SIGTERM');return;}
    let index;
    while((index=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,index);this.buffer=this.buffer.slice(index+1);if(!line.trim())continue;
      let packet;try{packet=JSON.parse(line);}catch{continue;}
      if(packet.method&&packet.id!==undefined){this.handleServerRequest(packet);continue;}
      if(packet.id!==undefined){const pending=this.pending.get(packet.id);if(!pending)continue;clearTimeout(pending.timer);this.pending.delete(packet.id);
        if(packet.error)pending.reject(this.rpcError(packet.error));
        else pending.resolve(packet.result);continue;}
      if(packet.method)this.emit('notification',packet.method,packet.params||{});
    }
  }
  rpcError(){return codexError('CODEX_RPC_ERROR','Codex 请求失败，请检查登录、模型权限或额度。');}
  handleServerRequest(packet) {
    let result;
    if(['item/commandExecution/requestApproval','item/fileChange/requestApproval','execCommandApproval','applyPatchApproval'].includes(packet.method))result={decision:'decline'};
    else if(packet.method==='item/permissions/requestApproval')result={permissions:{},scope:'turn'};
    else if(packet.method==='item/tool/requestUserInput')result={answers:{}};
    else if(packet.method==='item/tool/call')result={contentItems:[{type:'inputText',text:'此工作台仅接收文字和图片结果，不提供该工具。'}],success:false};
    if(result!==undefined)this.write({id:packet.id,result});
    else this.write({id:packet.id,error:{code:-32601,message:'Unsupported request in prompt workspace'}});
  }
  failAll(error) {this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();}
  async close() {
    const child=this.child;if(!child||!child.pid)return;
    child.stdin.end();
    if(child.exitCode!==null||child.signalCode!==null){this.failAll(codexError('CODEX_DISCONNECTED','Codex 已关闭'));return;}
    let timer;
    try{await Promise.race([this.exit,new Promise((_,reject)=>{timer=setTimeout(()=>reject(codexError('CODEX_CLOSE_UNSETTLED','Codex 进程尚未结清')),5000);})]);}
    catch(e){child.kill('SIGTERM');await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(e),5000);this.exit.then(()=>{clearTimeout(t);resolve();});});}
    finally{clearTimeout(timer);}
  }
}
