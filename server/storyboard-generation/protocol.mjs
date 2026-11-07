import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {digest} from '../project-assets/model.mjs';
import {PROFILE} from './validation.mjs';
const run=promisify(execFile),cache=new WeakMap();
export async function inspectProtocol(client){
 if(cache.has(client))return cache.get(client);
 const work=(async()=>{const command=client.commandResolved;if(typeof command!=='string')return{supported:false,reason:'OUTPUT_SCHEMA_PROTOCOL_UNKNOWN'};
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'shiguang-codex-protocol-'));
  try{
   const before=await fs.stat(command);if(!client.commandIdentity||client.commandIdentity.size!==before.size||client.commandIdentity.mtimeMs!==before.mtimeMs)return{supported:false,reason:'CODEX_BINARY_CHANGED'};await run(command,['app-server','generate-json-schema','--out',dir],{timeout:5000,maxBuffer:128*1024,windowsHide:true});const after=await fs.stat(command);
   if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)return{supported:false,reason:'CODEX_BINARY_CHANGED'};
   let found=null;async function visit(at,depth=0){if(depth>3)return;for(const e of await fs.readdir(at,{withFileTypes:true})){if(e.isSymbolicLink())continue;const file=path.join(at,e.name);if(e.isDirectory())await visit(file,depth+1);else if(/TurnStartParams[.]json$/i.test(e.name)&&e.isFile()&&(await fs.stat(file)).size<2*1024*1024){const raw=await fs.readFile(file,'utf8'),schema=JSON.parse(raw);if(schema.properties?.outputSchema)found={supported:true,profile:PROFILE,protocolHash:digest(raw),verifiedBy:'local-protocol-schema',upstreamAcceptance:'unverifiedUntilTurn'};}}}await visit(dir);
   return found??{supported:false,reason:'OUTPUT_SCHEMA_UNSUPPORTED'};
  }catch{return{supported:false,reason:'OUTPUT_SCHEMA_PROTOCOL_UNKNOWN'};}finally{await fs.rm(dir,{recursive:true,force:true});}
 })();cache.set(client,work);return work;
}
