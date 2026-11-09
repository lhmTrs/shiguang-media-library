import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {error,privateDirectory} from './files.mjs';
const run=promisify(execFile);
const xml = value => String(value).replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
function node(value) {
  if(Array.isArray(value))return '<array>'+value.map(node).join('')+'</array>';
  if(typeof value==='boolean')return value?'<true/>':'<false/>';
  if(typeof value==='number')return '<integer>'+value+'</integer>';
  if(value&&typeof value==='object')return '<dict>'+Object.entries(value).map(([k,v])=>'<key>'+xml(k)+'</key>'+node(v)).join('')+'</dict>';
  return '<string>'+xml(value)+'</string>';
}
export const plist = value => '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0">'+node(value)+'</plist>';
export const shellQuote = s => "'"+s.replace(/'/g,"'\"'\"'")+"'";
export function workflow(nodePath,script,config) {
  const source='exec '+[nodePath,script,'--config',config,'--'].map(shellQuote).join(' ')+' "$@"';
  const action={ActionBundlePath:'/System/Library/Automator/Run Shell Script.action',
    ActionName:'Run Shell Script',AMActionVersion:'2.0.3',BundleIdentifier:'com.apple.RunShellScript',
    'Class Name':'RunShellScriptAction',UUID:randomUUID(),InputUUID:randomUUID(),OutputUUID:randomUUID(),
    AMAccepts:{Container:'List',Types:['com.apple.cocoa.string'],Optional:true},
    AMProvides:{Container:'List',Types:['com.apple.cocoa.string']},
    ActionParameters:{inputMethod:1,CheckedForUserDefaultShell:true,COMMAND_STRING:source,source:'',shell:'/bin/sh'},
    isViewVisible:true,CanShowWhenRun:false,ShowWhenRun:false};
  return {AMDocumentVersion:'2',AMApplicationVersion:'2.10',actions:[{action,isViewVisible:true}],connectors:{},
    workflowMetaData:{workflowTypeIdentifier:'com.apple.Automator.servicesMenu',serviceProcessesInput:0,
      serviceApplicationBundleID:'com.apple.finder',serviceApplicationPath:'/System/Library/CoreServices/Finder.app',
      serviceInputTypeIdentifier:'com.apple.Automator.fileSystemObject.movie',serviceOutputTypeIdentifier:'com.apple.Automator.nothing'}};
}

export class IntakeNative {
  constructor({dataDir,project,personalItemDirectory,servicesDirectory=path.join(os.homedir(),'Library/Services'),platform=process.platform,serviceTitle='收纳视频到拾光'}) {
    this.dataDir=dataDir;this.project=project;this.personalItemDirectory=personalItemDirectory;this.servicesDirectory=servicesDirectory;
    if(!serviceTitle||/[\\/\x00-\x1f]/.test(serviceTitle))throw error('INTAKE_INSTALL_INVALID','右键入口名称无效');
    this.platform=platform;this.serviceTitle=serviceTitle;this.target=path.join(servicesDirectory,serviceTitle+'.workflow');this.installing=null;
    this.nativeDir=path.join(dataDir,'file-intake','native');
  }
  supported(){return this.platform==='darwin'&&process.env.MEDIA_CONTAINER!=='1'&&process.env.MEDIA_READONLY_FILES!=='1';}
  async status(){
    if(!this.supported())return {supported:false,installed:false};
    try {
      const st=await fs.lstat(this.target);if(!st.isDirectory()||st.isSymbolicLink())return {supported:true,installed:false};
      const marker=JSON.parse(await fs.readFile(path.join(this.target,'Contents/shiguang-install.json'),'utf8'));
      return {supported:true,installed:marker.owner==='shiguang-file-intake-v1'&&marker.project===this.project&&marker.dataDir===this.dataDir};
    }catch{return {supported:true,installed:false};}
  }
  install(){if(!this.installing)this.installing=this.performInstall().finally(()=>{this.installing=null;});return this.installing;}
  async performInstall(){
    if(this.closing)throw error('APPLICATION_CLOSING','服务正在关闭，未安装右键入口',503);
    if(!this.supported())throw error('INTAKE_MAC_ONLY','访达右键入口目前仅支持本机 Mac',400);
    const native=await privateDirectory(this.nativeDir);
    let old;
    try {const st=await fs.lstat(this.target);if(!st.isDirectory()||st.isSymbolicLink())throw error('INTAKE_INSTALL_CONFLICT','同名系统入口不是拾光创建的，未替换');
      old=JSON.parse(await fs.readFile(path.join(this.target,'Contents/shiguang-install.json'),'utf8'));
      if(old.owner!=='shiguang-file-intake-v1'||old.dataDir!==this.dataDir)throw error('INTAKE_INSTALL_CONFLICT','同名入口属于其他安装，未替换');
    }catch(e){if(e.code!=='ENOENT')throw e;}
    const source=path.join(import.meta.dirname,'window.swift'),version=createHash('sha256').update(await fs.readFile(source)).digest('hex').slice(0,16);
    const helper=path.join(native,'intake-window-'+version);
    try {await fs.access(helper);}catch {
      const temporary=helper+'.'+randomUUID();
      try {await run('/usr/bin/swiftc',['-module-cache-path',path.join(native,'module-cache'),source,'-o',temporary,'-framework','Cocoa','-framework','WebKit'],{timeout:120000,maxBuffer:65536});await fs.chmod(temporary,0o700);await fs.rename(temporary,helper);}
      catch(e){await fs.unlink(temporary).catch(()=>{});throw error('INTAKE_COMPILER_UNAVAILABLE','无法准备本机窗口组件，请先安装 Mac 命令行工具后再试；未安装右键入口',409);}
    }
    if(this.closing)throw error('APPLICATION_CLOSING','服务正在关闭，未安装右键入口',503);
    const config=path.join(native,'install-'+randomUUID()+'.json');
    await fs.writeFile(config,JSON.stringify({format:1,node:process.execPath,project:this.project,dataDir:this.dataDir,
      personalItemDirectory:this.personalItemDirectory,helper}),{flag:'wx',mode:0o600});
    await fs.mkdir(this.servicesDirectory,{recursive:true});
    if(await fs.realpath(this.servicesDirectory)!==this.servicesDirectory)throw error('INTAKE_INSTALL_CONFLICT','系统服务目录位置异常，未安装');
    const staged=path.join(this.servicesDirectory,'.shiguang-intake-'+randomUUID()+'.workflow');
    await fs.mkdir(path.join(staged,'Contents/Resources'),{recursive:true});
    const info={CFBundleIdentifier:'com.shiguang.file-intake.'+createHash('sha256').update(this.serviceTitle).digest('hex').slice(0,12),CFBundleName:this.serviceTitle,CFBundleVersion:'1',
      NSServices:[{NSMenuItem:{default:this.serviceTitle},NSMessage:'runWorkflowAsService',
        NSRequiredContext:{NSApplicationIdentifier:'com.apple.finder'},NSSendFileTypes:['public.movie']}]};
    await fs.writeFile(path.join(staged,'Contents/Info.plist'),plist(info));
    await fs.writeFile(path.join(staged,'Contents/Resources/document.wflow'),plist(workflow(process.execPath,path.join(this.project,'scripts/finder-intake.mjs'),config)));
    await fs.writeFile(path.join(staged,'Contents/shiguang-install.json'),JSON.stringify({owner:'shiguang-file-intake-v1',project:this.project,dataDir:this.dataDir}));
    if(old)await fs.rename(this.target,path.join(native,'previous-workflow-'+randomUUID()));
    await fs.rename(staged,this.target);
    return {installed:true,message:'右键入口已安装。首次请在系统设置 → 键盘 → 键盘快捷键 → 服务，启用“收纳视频到拾光”；随后在访达选择视频使用。'};
  }
  beginClose(){this.closing=true;}
  async close(){this.beginClose();if(!this.installing)return;let timer;
    try{await Promise.race([this.installing.catch(e=>{if(e.code!=='APPLICATION_CLOSING')throw e;}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(error('INTAKE_INSTALL_UNSETTLED','本机窗口组件仍在准备，未强制终止')),10000);})]);}
    finally{clearTimeout(timer);}
  }
}
