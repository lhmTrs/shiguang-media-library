import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {digest,fault} from '../project-assets/model.mjs';
import {validatePackage} from './rules.mjs';

const fail=(message,status=400,code='SKILL_IMPORT_INVALID')=>{throw fault(message,status,{code});};
const relative=p=>typeof p==='string'&&p.length<=200&&!p.includes('\\')&&!p.includes('\0')&&!p.includes(':')&&!p.startsWith('/')&&p.split('/').every(x=>x&&x!=='.'&&x!=='..');
const clean=(value,max)=>typeof value==='string'?value.slice(0,max):'';
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs&&a.nlink===b.nlink;

// Discovery belongs to the existing Codex connection. Never starts a model turn,
// scans guessed home directories, installs skills or changes their enabled state.
export class CodexSkillCatalog{
  constructor(codex,{cwd=fileURLToPath(new URL('../../',import.meta.url))}={}){this.codex=codex;this.cwd=path.resolve(cwd);this.catalog=null;this.epoch=0;this.serial=0;this.observed=new WeakSet();}
  client(){const c=this.codex;if(c.closing||c.resetting||c.transportUnsettled)fail('Codex 连接正在结清，请稍后读取技能',423,'CODEX_BUSY');if(!c.client||c.client.closed)fail('请先连接本机 Codex，再读取技能列表',409,'SKILL_CODEX_NOT_CONNECTED');return c.client;}
  activity(fn){return this.codex.withActivity?this.codex.withActivity(fn):fn();}
  async list(){return this.activity(async()=>{
    const client=this.client();
    if(!this.observed.has(client)){this.observed.add(client);client.on?.('notification',method=>{if(method==='skills/changed'){this.epoch++;if(this.catalog?.client===client)this.catalog=null;}});}
    const epoch=this.epoch,serial=++this.serial;let response;try{response=await client.call('skills/list',{cwds:[this.cwd],forceReload:true});}catch{fail('Codex 未能返回技能列表，请检查本机版本或重新连接后重试',503,'SKILL_LIST_UNAVAILABLE');}
    if(this.client()!==client)fail('Codex 连接已变化，请重新读取技能列表',409,'SKILL_CATALOG_STALE');
    if(epoch!==this.epoch||serial!==this.serial)fail('技能目录在读取时发生变化，请刷新后重试',409,'SKILL_CATALOG_STALE');
    const entry=Array.isArray(response?.data)&&response.data.find(v=>v.cwd===this.cwd);
    if(!entry||!Array.isArray(entry.skills)||entry.skills.length>3000||!Array.isArray(entry.errors))fail('当前 Codex 技能列表格式不兼容，请更新后重试',503,'SKILL_LIST_UNAVAILABLE');
    const catalog={id:randomUUID(),client,expiresAt:Date.now()+5*60*1000,skills:new Map()};
    const skills=entry.skills.map(s=>{
      if(typeof s?.name!=='string'||typeof s.path!=='string'||typeof s.enabled!=='boolean')fail('Codex 返回了无法确认的技能记录',503,'SKILL_LIST_UNAVAILABLE');
      const id=randomUUID(),local=path.isAbsolute(s.path)&&path.basename(s.path).toLowerCase()==='skill.md';catalog.skills.set(id,{...s,path:s.path});
      return{id,name:clean(s.name,200),title:clean(s.interface?.displayName||s.name,200),description:clean(s.interface?.shortDescription||s.description||s.shortDescription,2000),scope:['user','repo','system','admin'].includes(s.scope)?s.scope:'unknown',enabled:s.enabled,importable:local&&s.enabled,toolDependencies:Array.isArray(s.dependencies?.tools)?s.dependencies.tools.length:0};
    });
    this.catalog=catalog;return{catalogId:catalog.id,skills,unreadableCount:entry.errors.length,expiresAt:catalog.expiresAt};
  });}
  async preview(input){return this.activity(async()=>{
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['catalogId','skillId'].includes(k)))fail('请选择技能列表中的一项');
    const client=this.client(),catalog=this.catalog,skill=catalog?.skills.get(input.skillId);
    if(!catalog||catalog.id!==input.catalogId||catalog.client!==client||catalog.expiresAt<=Date.now()||!skill)fail('技能列表已变化或过期，请刷新后重新选择',409,'SKILL_CATALOG_STALE');
    if(!skill.enabled)fail('此技能在 Codex 中已停用，请先在 Codex 启用后刷新');
    if(!path.isAbsolute(skill.path)||path.basename(skill.path).toLowerCase()!=='skill.md')fail('此技能没有可导入的本机 SKILL.md 正文');
    const declared=await fs.lstat(skill.path).catch(()=>fail('技能正文已不存在，请刷新技能列表',409));
    if(declared.isSymbolicLink())fail('技能入口包含符号链接，请使用技能目录内的 SKILL.md 正文');
    const root=await fs.realpath(path.dirname(skill.path)),entry=path.join(root,path.basename(skill.path));
    if(await fs.realpath(skill.path)!==entry||!same(declared,await fs.lstat(entry)))fail('技能入口已变化，请重新选择',409,'SKILL_SOURCE_CHANGED');
    const rootIdentity=await fs.lstat(root),files=[],pending=[path.basename(entry)],seen=new Set();let total=0;
    const checkCatalog=()=>{if(this.client()!==client||this.catalog!==catalog||catalog.expiresAt<=Date.now())fail('技能目录或连接已变化或过期，请刷新后重新预览',409,'SKILL_CATALOG_STALE');};
    const checkRoot=async()=>{const stat=await fs.lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.dev!==rootIdentity.dev||stat.ino!==rootIdentity.ino||await fs.realpath(root)!==root)fail('技能目录已变化，请重新选择',409,'SKILL_SOURCE_CHANGED');};
    while(pending.length){
      const name=pending.shift();if(seen.has(name))continue;seen.add(name);
      if(!relative(name)||!/[.](md|txt|json)$/i.test(name))fail('技能引用 '+name+' 不是可导入的规则文本；脚本、图片和外部链接不会执行或读取');
      if(seen.size>32)fail('技能引用超过32个文件，请整理后再导入');await checkRoot();
      const target=path.join(root,...name.split('/')),directories=[];let at=root,before;
      for(const part of name.split('/')){at=path.join(at,part);const stat=await fs.lstat(at).catch(()=>fail('技能引用缺失：'+name));if(stat.isSymbolicLink())fail('技能引用包含符号链接：'+name);if(at===target)before=stat;else{if(!stat.isDirectory())fail('技能引用目录不支持：'+name);directories.push({path:at,stat});}}
      if(!before.isFile()||before.nlink!==1||before.size>128*1024)fail('技能文件类型或大小不支持：'+name);
      // Pin every ancestor as well as the opened file. A parent changed between
      // lstat and open must be rejected before any bytes from that handle are read.
      const checkPath=async()=>{await checkRoot();for(const d of directories){const now=await fs.lstat(d.path);if(!now.isDirectory()||now.isSymbolicLink()||now.dev!==d.stat.dev||now.ino!==d.stat.ino)fail('技能引用目录已变化，请重新选择',409,'SKILL_SOURCE_CHANGED');}const now=await fs.lstat(target);if(now.isSymbolicLink()||!same(before,now)||await fs.realpath(target)!==target)fail('技能文件已变化，请重试',409,'SKILL_SOURCE_CHANGED');};
      await checkPath();
      const handle=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW);let body;
      try{if(!same(before,await handle.stat()))fail('技能文件已变化，请重试',409,'SKILL_SOURCE_CHANGED');await checkPath();checkCatalog();const buffer=Buffer.alloc(before.size+1),{bytesRead}=await handle.read(buffer,0,buffer.length,0);if(bytesRead!==before.size||!same(before,await handle.stat()))fail('技能文件在读取时变化，请重试',409,'SKILL_SOURCE_CHANGED');await checkPath();try{body=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,bytesRead));}catch{fail('技能文件不是有效 UTF-8 文本：'+name);}}finally{await handle.close();}
      total+=Buffer.byteLength(body);if(total>512*1024)fail('技能规则包超过512KiB，请减少引用');files.push({path:name,text:body});
      if(name.endsWith('.md')){
        const refs=[...body.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)].map(m=>m[1].split('#')[0]).filter(Boolean);
        for(const m of body.matchAll(/[`"']((?:references|templates|examples|assets)\/[^`"'\n]+\.(?:md|txt|json))[`"']/g))refs.push(m[1]);
        for(const ref of refs){if(!relative(ref))fail('技能包含外部或越界引用：'+ref+'；请改为技能目录内的文字规则后再导入');const resolved=path.posix.join(path.posix.dirname(name),ref);if(!seen.has(resolved))pending.push(resolved);}
      }
    }
    await checkRoot();checkCatalog();
    const tools=Array.isArray(skill.dependencies?.tools)?skill.dependencies.tools:[],requires=[...new Set(tools.map(t=>'tool:'+clean(t.type||'unknown',60)))];
    const pack=validatePackage({format:'shiguang-rule-package-v1',entry:path.basename(entry),files,references:files.slice(1).map(f=>f.path),optionalReferences:[],compatibility:'unknown',requires,conflicts:[]});
    const hash=digest(pack);
    checkCatalog();
    return{name:clean(skill.interface?.displayName||skill.name,120),source:'codex-skill:'+clean(skill.name,100),revision:'Codex快照 '+hash.slice(0,12),contentHash:hash,package:pack,warnings:tools.length?['此技能声明了额外工具依赖。这里只导入文字规则，不开放工具；现有生成检查会拦截不支持的能力。']:[],fileCount:files.length,totalBytes:total};
  });}
}
