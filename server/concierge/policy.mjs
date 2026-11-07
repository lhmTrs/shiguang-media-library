import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fault} from './store.mjs';

// An empty MCP table is merged with existing settings by Codex. Disable each
// configured server explicitly. Raw configuration stays in memory only; callers
// receive neither config contents nor credentials, and nothing is persisted.
export async function conciergeConfig(client,cwd,attachments){
  const result=await client.call('config/read',{includeLayers:true,cwd});
  if(!Array.isArray(result.layers))throw fault('当前 Codex 无法核对管家工具范围，请更新 Codex 后重连',503);
  const servers=new Set(),plugins=new Set();
  for(const layer of result.layers){
    for(const [key,names]of [['mcp_servers',servers],['plugins',plugins]]){
      const table=layer.config?.[key];if(table==null)continue;
      if(typeof table!=='object'||Array.isArray(table))throw fault('无法安全核对本机 Codex 工具设置',503);
      for(const name of Object.keys(table)){if(name.length>500||/[\x00-\x1f]/.test(name))throw fault('本机 Codex 工具名称无效',503);names.add(name);}
    }
  }
  plugins.add('_default');
  // A fresh name prevents merging with unrelated user profiles. No broad-read
  // fallback: an unsupported named profile must reject before starting a turn.
  const permissions='shiguang_concierge_'+randomUUID().replaceAll('-','');
  client.permissionProfile=permissions;
  const executable=client.commandResolved&&await fs.realpath(client.commandResolved);
  const profile={filesystem:{':minimal':'read',[cwd]:'read',[attachments]:'read',...(executable?{[executable]:'read',[client.commandResolved]:'read'}:{})},network:{enabled:false}};
  return {permissions:{[permissions]:profile},'features.shell_tool':false,'features.apply_patch_freeform':false,'features.multi_agent':false,'features.apps':false,'features.plugins':false,'features.remote_plugin':false,'features.browser_use':false,'features.computer_use':false,mcp_servers:Object.fromEntries([...servers].map(n=>[n,{enabled:false}])),plugins:Object.fromEntries([...plugins].map(n=>[n,{enabled:false}]))};
}
