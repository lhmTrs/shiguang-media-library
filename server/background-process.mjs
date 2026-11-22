import * as native from 'node:child_process';
import {promisify} from 'node:util';
const options=args=>{
 if(process.platform!=='win32')return args;
 const result=[...args],index=Array.isArray(result[1])?2:1;
 if(result[index]&&typeof result[index]==='object')result[index]={...result[index],windowsHide:true};
 else result.splice(index,0,{windowsHide:true});
 return result;
};
// Delegate through live native exports so existing observers and test seams
// retain ownership of child creation after this module has been imported.
export function spawn(...args){return native.spawn(...options(args));}
export function spawnSync(...args){return native.spawnSync(...options(args));}
export function execFile(...args){return native.execFile(...options(args));}
Object.defineProperty(execFile,promisify.custom,{value:(...args)=>promisify(native.execFile)(...options(args))});
