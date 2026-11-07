import fs from 'node:fs/promises';
import {CodexTransport,codexError,findCodex} from '../prompt-codex/transport.mjs';
// This subclass owns only the concierge connection. Legacy template requests retain their policy.
export class ConciergeTransport extends CodexTransport{
  constructor(options={}){super({...options,args:options.args??['app-server','--listen','stdio://','-c','features.shell_tool=false','-c','features.apply_patch_freeform=false','-c','features.multi_agent=false','-c','features.apps=false','-c','features.plugins=false','-c','features.remote_plugin=false','-c','features.browser_use=false','-c','features.computer_use=false','-c','approval_policy="never"','-c','sandbox_mode="read-only"'],experimentalApi:true,clientInfo:{name:'shiguang_concierge',title:'拾光项目管家',version:'1.0.0'}});this.onTool=options.onTool;}
  async start(){this.command=await fs.realpath(this.command||await findCodex());return super.start();}
  rpcError(error){if(error?.code===-32600&&/^thread [a-zA-Z0-9_-]{1,100} is not materialized yet; thread\/turns\/list is unavailable before first user message$/.test(error.message??''))return codexError('CODEX_THREAD_EMPTY','此对话尚未收到首条消息，暂无历史。',409);if(error?.code===-32600&&/^(?:error resuming thread: )?no rollout found for thread id [a-zA-Z0-9_-]{1,100}$/i.test(error.message??''))return codexError('CODEX_THREAD_NOT_FOUND','本机 Codex 尚未保存这个对话；请核对原上下文，未自动替换或重发。',409);if(error?.code===-32600&&/^thread not loaded: [a-zA-Z0-9_-]{1,100}$/.test(error.message??''))return codexError('CODEX_THREAD_NOT_LOADED','原对话尚未载入，请点击“核对原上下文 / 本轮”；不会重新生成或替换历史。',409);if(error?.code===-32602||error?.code===-32600&&/^Invalid request:/.test(error.message??''))return codexError('CODEX_PROTOCOL_INCOMPATIBLE','管家请求参数与本机 Codex 协议不兼容，本轮未能启动；请更新素材管理器后重新连接。');if(error?.code===-32603&&/^error (creating|resuming) thread: failed to load AGENTS\.md instructions/.test(error.message??''))return codexError('CODEX_PERMISSION_SETUP_FAILED','本机 Codex 未能建立受限读取环境，本轮未能启动；请检查安装路径与版本。');if(error?.code===-32600)return codexError('CODEX_THREAD_STATE','Codex 暂不能读取或继续这个对话，请核对原上下文；未自动重发。',409);return super.rpcError(error);}
  async handleServerRequest(packet){
    if(packet.method!=='item/tool/call')return super.handleServerRequest(packet);
    let result;
    try{if(!this.onTool)throw codexError('CONCIERGE_TOOL_UNAVAILABLE','管家工具尚未就绪');const value=await this.onTool(packet.params);result={success:true,contentItems:[{type:'inputText',text:JSON.stringify(value)}]};}
    catch(e){result={success:false,contentItems:[{type:'inputText',text:JSON.stringify({error:e.message||'业务操作失败',code:e.code||'CONCIERGE_TOOL_FAILED'})}]};}
    if(!this.closed)try{this.write({id:packet.id,result});}catch{}
  }
}
