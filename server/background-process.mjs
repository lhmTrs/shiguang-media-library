import * as native from 'node:child_process';
import {promisify} from 'node:util';
const options=args=>{
 if(process.platform!=='win32')return args;
 const result=[...args],index=Array.isArray(result[1])?2:1;
 if(result[index]&&typeof result[index]==='object')result[index]={...result[index],windowsHide:true};
 else result.splice(index,0,{windowsHide:true});
 return result;
};
const wrap=fn=>{
 if(process.platform!=='win32')return fn;
 const wrapped=function(...args){return Reflect.apply(fn,this,options(args));};
 if(fn[promisify.custom])Object.defineProperty(wrapped,promisify.custom,{value:(...args)=>fn[promisify.custom](...options(args))});
 return wrapped;
};
export const spawn=wrap(native.spawn),execFile=wrap(native.execFile),spawnSync=wrap(native.spawnSync);
