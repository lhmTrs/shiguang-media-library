import {execFile,spawn} from './background-process.mjs';
import {promisify} from 'node:util';
import {mediaCommand} from './media-tool.mjs';
const nativeRun=promisify(execFile);
export function runMedia(command,args,options) {
 return nativeRun(mediaCommand(command,{env:options?.env??process.env}),args,process.platform==='win32'?{...options,windowsHide:true}:options);
}
export function spawnMedia(command,args,options) {
 return spawn(mediaCommand(command,{env:options?.env??process.env}),args,process.platform==='win32'?{...options,windowsHide:true}:options);
}
// Only process creation is acknowledged. Windows Explorer forwards to a desktop
// process and its later exit status cannot prove a window was opened.
export function revealWindows(file,{spawnImpl=spawn}={}) {
 return new Promise((resolve,reject)=>{
  const child=spawnImpl('explorer.exe',['/select,'+file],{shell:false,windowsHide:true,stdio:'ignore'});
  child.once('error',reject);child.once('spawn',()=>{child.unref();resolve({status:'spawned',desktopVerified:false});});
 });
}
