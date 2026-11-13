import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {constants} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {error,privateDirectory,uuid} from './files.mjs';
const run=promisify(execFile);
const serviceTitle='收纳素材到拾光', legacyTitle='收纳视频到拾光';
const mediaKinds=['photo','video','audio'], fileTypes=['public.image','public.movie','public.audio'];
const owner='shiguang-file-intake-v1';
const windowSource=path.join(import.meta.dirname,'window.swift');
const windowVersion=async()=>createHash('sha256').update(await fs.readFile(windowSource)).digest('hex').slice(0,16);
const currentMarker=(marker,version)=>marker.version===2&&marker.windowVersion===version&&Array.isArray(marker.mediaKinds)&&mediaKinds.every(kind=>marker.mediaKinds.includes(kind));
const identity=st=>({dev:String(st.dev),ino:String(st.ino)});
const sameEntry=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
const installStages=new Set(['checking','preparing-window','writing','done','failed']);
const installFinished=job=>job.stage==='done'||job.stage==='failed';
const installError=(cause,fallback)=>({
  code:/^[A-Z_]{1,64}$/.test(cause?.code??'')?cause.code:'INTAKE_INSTALL_FAILED',
  message:cause?.status&&cause.message?cause.message:fallback,
});
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
      serviceInputTypeIdentifier:'com.apple.Automator.fileSystemObject',serviceOutputTypeIdentifier:'com.apple.Automator.nothing'}};
}

export class IntakeNative {
  constructor({dataDir,project,personalItemDirectory,servicesDirectory=path.join(os.homedir(),'Library/Services'),platform=process.platform,serviceTitle:title=serviceTitle,runner=run}) {
    this.dataDir=dataDir;this.project=project;this.personalItemDirectory=personalItemDirectory;this.servicesDirectory=servicesDirectory;
    if(typeof title!=='string'||!title||/[\\/\x00-\x1f]/.test(title))throw error('INTAKE_INSTALL_INVALID','右键入口名称无效');
    this.platform=platform;this.serviceTitle=title;this.target=path.join(servicesDirectory,title+'.workflow');this.installing=null;this.run=runner;
    this.legacyTarget=title===serviceTitle?path.join(servicesDirectory,legacyTitle+'.workflow'):null;
    this.nativeDir=path.join(dataDir,'file-intake','native');
    this.jobFile=path.join(dataDir,'file-intake','install-job.json');
    this.job=null;
  }
  supported(){return this.platform==='darwin'&&process.env.MEDIA_CONTAINER!=='1'&&process.env.MEDIA_READONLY_FILES!=='1';}
  async init() {
    if(!this.supported())return this;
    let handle;
    try {
      const directory=await privateDirectory(path.dirname(this.jobFile));
      handle=await fs.open(path.join(directory,path.basename(this.jobFile)),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const st=await handle.stat();
      if(!st.isFile()||st.size>16384||(process.getuid&&st.uid!==process.getuid())||(st.mode&0o077))return this;
      const saved=JSON.parse(await handle.readFile('utf8'));
      const job=saved.job;
      if(saved.version!==1||!uuid(job?.id)||!installStages.has(job.stage)||!Number.isSafeInteger(job.startedAt))return this;
      this.job={
        id:job.id,stage:job.stage,window:['compiling','skipped'].includes(job.window)?job.window:null,
        startedAt:job.startedAt,finishedAt:Number.isSafeInteger(job.finishedAt)?job.finishedAt:null,
        message:typeof job.message==='string'?job.message:null,
        error:typeof job.error?.code==='string'&&typeof job.error?.message==='string'
          ?{code:job.error.code,message:job.error.message}:null,
        previousKept:typeof job.previousKept==='boolean'?job.previousKept:null,
      };
      if(!installFinished(this.job)){
        const failure=error('INSTALL_INTERRUPTED','上次安装被中断，可重试');
        await this.finishInstall(this.job, saved.previous, failure);
      }
    }catch(cause){
      if(cause.code!=='ENOENT')console.warn('INTAKE_INSTALL_RECEIPT_UNREADABLE');
    }finally{await handle?.close();}
    return this;
  }
  installJob(){return this.job?structuredClone(this.job):null;}
  async saveInstallJob(job,previous){
    const directory=await privateDirectory(path.dirname(this.jobFile));
    const target=path.join(directory,path.basename(this.jobFile));
    const temporary=target+'.'+randomUUID()+'.tmp';
    let handle;
    try {
      handle=await fs.open(temporary,'wx',0o600);
      await handle.writeFile(JSON.stringify({version:1,job,previous}));
      await handle.sync();
      await handle.close();handle=null;
      await fs.rename(temporary,target);
      const dir=await fs.open(directory,'r');
      try{await dir.sync();}finally{await dir.close();}
    }finally{await handle?.close();await fs.unlink(temporary).catch(()=>{});}
  }
  async previousKept(previous){
    if(!Array.isArray(previous))return null;
    if(!previous.length)return false;
    try {
      for(const entry of previous){
        const target=entry.slot==='current'?this.target:entry.slot==='legacy'?this.legacyTarget:null;
        if(!target)return null;
        const owned=await this.ownedWorkflow(target);
        if(!owned||!sameEntry(owned.identity,entry.identity))return false;
      }
      return true;
    }catch(cause){return cause.code==='INTAKE_INSTALL_CONFLICT'?false:null;}
  }
  async finishInstall(job,previous,failure,result){
    const problem=failure?installError(failure,'访达入口安装失败，请核对后重试'):null;
    const terminal={
      ...job,stage:failure?'failed':'done',finishedAt:Date.now(),error:problem,
      message:problem?.message??result.message,previousKept:failure?await this.previousKept(previous):null,
    };
    try{await this.saveInstallJob(terminal,previous);}catch{
      terminal.message+='。本次结果未能保存，刷新后请核对入口状态';
      console.warn('INTAKE_INSTALL_RECEIPT_WRITE_FAILED');
    }
    this.job=terminal;
  }
  assertInstallAllowed(){
    if(this.closing)throw error('APPLICATION_CLOSING','服务正在关闭，未安装右键入口',503);
    if(!this.supported())throw error('INTAKE_MAC_ONLY','访达右键入口目前仅支持本机 Mac',400);
  }
  async ownedWorkflow(target) {
    let st;
    try{st=await fs.lstat(target);}catch(e){if(e.code==='ENOENT')return null;throw e;}
    const conflict=()=>error('INTAKE_INSTALL_CONFLICT','同名入口不是当前拾光安装创建的，未替换');
    if(!st.isDirectory()||st.isSymbolicLink()||(process.getuid&&st.uid!==process.getuid()))throw conflict();
    const contents=await fs.lstat(path.join(target,'Contents')).catch(()=>null);
    if(!contents?.isDirectory()||contents.isSymbolicLink())throw conflict();
    let handle;
    try {
      handle=await fs.open(path.join(target,'Contents/shiguang-install.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const markerStat=await handle.stat();
      if(!markerStat.isFile()||markerStat.size>16384||(process.getuid&&markerStat.uid!==process.getuid()))throw conflict();
      const marker=JSON.parse(await handle.readFile('utf8'));
      if(marker?.owner!==owner||marker.project!==this.project||marker.dataDir!==this.dataDir)throw conflict();
      return {target,identity:identity(st),marker};
    }catch{throw conflict();}finally{await handle?.close();}
  }
  async legacyWorkflow() {
    if(!this.legacyTarget)return null;
    try{return await this.ownedWorkflow(this.legacyTarget);}catch(e){if(e.code==='INTAKE_INSTALL_CONFLICT')return null;throw e;}
  }
  async status(){
    if(!this.supported())return {supported:false,installed:false,upgradeNeeded:false};
    let installed;
    try {
      installed=await this.ownedWorkflow(this.target);
    }catch{}
    const legacy=await this.legacyWorkflow().catch(()=>null);
    return {supported:true,installed:!!(installed||legacy),upgradeNeeded:!!legacy||!!installed&&!currentMarker(installed.marker,await windowVersion())};
  }
  install(withActivity=fn=>fn()){
    if(this.installing)return this.installing;
    const admission=Promise.withResolvers();
    // Legacy callers wait for the install, and background callers wait for admission.
    // Both promises can reject before the other caller attaches.
    void admission.promise.catch(()=>{});
    this.installAdmission=admission.promise;
    const job={id:randomUUID(),stage:'checking',window:null,startedAt:Date.now(),
      finishedAt:null,message:null,error:null,previousKept:null};
    this.installing=Promise.resolve().then(()=>withActivity(async()=>{
      this.assertInstallAllowed();
      try{await this.saveInstallJob(job,null);}catch{
        throw error('INTAKE_INSTALL_RECEIPT_WRITE_FAILED','无法记录本次安装，请检查本机数据目录后重试');
      }
      this.job=job;
      admission.resolve(this.installJob());
      let previous=null;
      try {
        const result=await this.performInstall({
          recordPrevious:async workflows=>{
            previous=workflows.map(({target,identity})=>({slot:target===this.target?'current':'legacy',identity}));
            await this.saveInstallJob(job,previous);
          },
          progress:(stage,window=job.window)=>{Object.assign(job,{stage,window});},
        });
        await this.finishInstall(job,previous,null,result);
        return result;
      }catch(failure){
        await this.finishInstall(job,previous,failure);
        throw failure;
      }
    })).catch(failure=>{
      admission.reject(failure);
      throw failure;
    }).finally(()=>{this.installing=null;this.installAdmission=null;});
    void this.installing.catch(()=>{});
    return this.installing;
  }
  async startInstall(withActivity){
    this.assertInstallAllowed();
    if(this.installing){
      await this.installAdmission;
      return this.installJob();
    }
    this.install(withActivity);
    return this.installAdmission;
  }
  async openServicesSettings(){
    if(this.closing)throw error('APPLICATION_CLOSING','服务正在关闭，请稍后再打开系统设置',503);
    if(!this.supported())throw error('INTAKE_MAC_ONLY','系统设置入口目前仅支持本机 Mac',400);
    const keyboardPane=Number(os.release().split('.')[0])>=22
      ? 'com.apple.Keyboard-Settings.extension' : 'com.apple.preference.keyboard';
    try{await this.run('/usr/bin/open',['x-apple.systempreferences:'+keyboardPane],{timeout:5000,maxBuffer:65536});}
    catch{throw error('INTAKE_SETTINGS_OPEN_FAILED','无法打开系统设置，请手动打开「键盘 → 键盘快捷键 → 服务」');}
    return {opened:true,target:'keyboard'};
  }
  async performInstall({recordPrevious,progress}){
    this.assertInstallAllowed();
    const native=await privateDirectory(this.nativeDir);
    // Check ownership before preparing anything. A missing/linked marker is a
    // conflict, never permission to replace an existing directory.
    const previous=[await this.ownedWorkflow(this.target),await this.legacyWorkflow()].filter(Boolean);
    await recordPrevious(previous);
    const version=await windowVersion();
    const bundle=path.join(native,'ShiguangIntake-'+version+'-v1.app');
    const helper=path.join(bundle,'Contents/MacOS/ShiguangIntake');
    let reuseHelper=true;
    try{await fs.access(helper);}catch{reuseHelper=false;}
    progress('preparing-window',reuseHelper?'skipped':'compiling');
    if(!reuseHelper){
      const temporary=path.join(native,'.intake-window-'+randomUUID()+'.app'),binary=path.join(temporary,'Contents/MacOS/ShiguangIntake');
      try {
        await fs.mkdir(path.dirname(binary),{recursive:true,mode:0o700});
        await this.run('/usr/bin/swiftc',['-module-cache-path',path.join(native,'module-cache'),windowSource,'-o',binary,'-framework','Cocoa','-framework','WebKit'],{timeout:120000,maxBuffer:65536});
        await fs.chmod(binary,0o700);
        await fs.writeFile(path.join(temporary,'Contents/Info.plist'),plist({CFBundleIdentifier:'com.shiguang.intake.'+createHash('sha256').update(native).digest('hex').slice(0,12),
          CFBundleName:'拾光素材收纳',CFBundleDisplayName:'拾光素材收纳',CFBundleExecutable:'ShiguangIntake',CFBundlePackageType:'APPL',CFBundleVersion:'2',
          NSHighResolutionCapable:true,LSMinimumSystemVersion:'11.0'}));
        await fs.rename(temporary,bundle);
      }
      catch(e){
        if(e.killed&&e.signal==='SIGTERM')throw error('INTAKE_COMPILER_TIMEOUT','准备本机窗口组件超时，请重试安装');
        throw error('INTAKE_COMPILER_UNAVAILABLE','无法准备本机窗口组件，请先安装 Mac 命令行工具后再试；未安装右键入口',409);
      }
      finally{await fs.rm(temporary,{recursive:true,force:true});}
    }
    if(this.closing)throw error('APPLICATION_CLOSING','服务正在关闭，未安装右键入口',503);
    progress('writing');
    const config=path.join(native,'install-'+randomUUID()+'.json');
    await fs.writeFile(config,JSON.stringify({format:1,node:process.execPath,project:this.project,dataDir:this.dataDir,
      personalItemDirectory:this.personalItemDirectory,helper}),{flag:'wx',mode:0o600});
    await fs.mkdir(this.servicesDirectory,{recursive:true});
    if(await fs.realpath(this.servicesDirectory)!==this.servicesDirectory)throw error('INTAKE_INSTALL_CONFLICT','系统服务目录位置异常，未安装');
    const staged=path.join(this.servicesDirectory,'.shiguang-intake-'+randomUUID()+'.workflow');
    const backups=[];
    try {
      await fs.mkdir(path.join(staged,'Contents/Resources'),{recursive:true});
      const info={CFBundleIdentifier:'com.shiguang.file-intake.'+createHash('sha256').update(this.serviceTitle).digest('hex').slice(0,12),CFBundleName:this.serviceTitle,CFBundleVersion:'2',
        NSServices:[{NSMenuItem:{default:this.serviceTitle},NSMessage:'runWorkflowAsService',
          NSRequiredContext:{NSApplicationIdentifier:'com.apple.finder'},NSSendFileTypes:fileTypes}]};
      await fs.writeFile(path.join(staged,'Contents/Info.plist'),plist(info));
      await fs.writeFile(path.join(staged,'Contents/Resources/document.wflow'),plist(workflow(process.execPath,path.join(this.project,'scripts/finder-intake.mjs'),config)));
      await fs.writeFile(path.join(staged,'Contents/shiguang-install.json'),JSON.stringify({owner,project:this.project,dataDir:this.dataDir,version:2,mediaKinds,windowVersion:version}));
      if(this.closing)throw error('APPLICATION_CLOSING','服务正在关闭，未安装右键入口',503);
      // Keep backups on the Services filesystem so both replacement and rollback
      // use atomic renames, even when dataDir lives on another volume. They have
      // no .workflow suffix and cannot become a second active menu item.
      for(const old of previous) {
        const current=await this.ownedWorkflow(old.target);
        if(!current||!sameEntry(current.identity,old.identity))throw error('INTAKE_INSTALL_CONFLICT','右键入口在准备期间已变化，未替换');
        const backup=path.join(this.servicesDirectory,'.shiguang-intake-previous-'+randomUUID());
        await fs.rename(old.target,backup);backups.push({...old,backup});
      }
      if(this.closing)throw error('APPLICATION_CLOSING','服务正在关闭，未安装右键入口',503);
      await this.assertMissing(this.target);
      await fs.rename(staged,this.target);
    } catch(e) {
      const failed=[];
      for(const old of backups.reverse()) {
        try{
          const saved=await this.ownedWorkflow(old.backup);
          if(!saved||!sameEntry(saved.identity,old.identity))throw error('INTAKE_INSTALL_CONFLICT','旧入口备份位置已变化，未覆盖');
          await this.assertMissing(old.target);await fs.rename(old.backup,old.target);
        }catch{failed.push(old.backup);}
      }
      if(failed.length)throw Object.assign(error('INTAKE_INSTALL_ROLLBACK_FAILED','右键入口安装失败，旧入口备份已保留；入口位置发生变化，未覆盖，请核对后再试'),{cause:e,backups:failed});
      throw e;
    } finally {await fs.rm(staged,{recursive:true,force:true});}
    return {installed:true,upgradeNeeded:false,message:`右键入口已安装。首次请在系统设置 → 键盘 → 键盘快捷键 → 服务，启用“${this.serviceTitle}”；随后在访达选择照片、视频或音频使用，音频需在收纳窗口中明确选择音乐或音效。`};
  }
  async assertMissing(target) {
    try{await fs.lstat(target);}catch(e){if(e.code==='ENOENT')return;throw e;}
    throw error('INTAKE_INSTALL_CONFLICT','右键入口位置已被占用，未覆盖');
  }
  beginClose(){this.closing=true;}
  async close(){this.beginClose();if(!this.installing)return;let timer;
    try{await Promise.race([this.installing.catch(e=>{if(e.code!=='APPLICATION_CLOSING')throw e;}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(error('INTAKE_INSTALL_UNSETTLED','本机窗口组件仍在准备，未强制终止')),10000);})]);}
    finally{clearTimeout(timer);}
  }
}
