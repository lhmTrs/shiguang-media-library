import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical,digest,fault,idOK,text} from '../project-assets/model.mjs';
export const BUILTIN_ID='62026110-0400-4000-8000-000000000001';
const bad=(message,field='rules')=>{throw fault(message,400,{code:'RULE_PACKAGE_INVALID',field});};
const relative=value=>typeof value==='string'&&value.length<=200&&!value.includes('\\')&&!value.includes('\0')&&!value.includes(':')&&!value.startsWith('/')&&value.split('/').every(x=>x&&x!=='.'&&x!=='..');
export function validatePackage(input){
 if(!input||input.format!=='shiguang-rule-package-v1'||!relative(input.entry)||!Array.isArray(input.files)||input.files.length<1||input.files.length>32)bad('需要完整的协议规则包');
 const paths=new Map();let size=0;
 for(const f of input.files){if(!f||!relative(f.path)||paths.has(f.path)||typeof f.text!=='string'||Buffer.byteLength(f.text)>128*1024||!/[.](?:md|txt|json)$/i.test(f.path)||Object.keys(f).some(k=>!['path','text'].includes(k)))bad('引用文件路径、类型、重复条目或大小无效');size+=Buffer.byteLength(f.text);paths.set(f.path,f.text);}
 if(size>512*1024||!paths.has(input.entry))bad('规则正文缺失或规则包超过512KiB');
 const refs=input.references??[],optional=input.optionalReferences??[];
 if(!Array.isArray(refs)||!Array.isArray(optional)||new Set([...refs,...optional]).size!==refs.length+optional.length)bad('必要或可选引用重复');
 const all=new Set([input.entry,...refs,...optional]);for(const r of all)if(!relative(r)||!paths.has(r))bad('规则包引用缺失');
 for(const [file,body]of paths){if(!all.has(file))bad('存在未声明文件');if(file.endsWith('.json')){try{JSON.parse(body);}catch{bad('规则JSON文件无效');}}if(!file.endsWith('.md'))continue;
  for(const match of body.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)){
   const target=match[1].split('#')[0];if(!target)continue;
   if(!relative(target))bad('规则引用不允许外部路径或网址');const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(file),target));if(!all.has(resolved)||!paths.has(resolved))bad('规则链接引用缺失');
  }
 }
 const requires=input.requires??[];if(!Array.isArray(requires)||requires.length>16||requires.some(x=>typeof x!=='string'||x.length>80))bad('协议能力声明无效');
 const conflicts=input.conflicts??[];if(!Array.isArray(conflicts)||conflicts.length>32||conflicts.some(x=>!idOK(x)))bad('协议冲突声明无效');
 if(!['storyboard','unrelated','unknown'].includes(input.compatibility??'unknown'))bad('兼容性声明无效');
 return {format:input.format,entry:input.entry,files:input.files.map(f=>({path:f.path,text:f.text})),references:[...refs],optionalReferences:[...optional],requires:[...requires],conflicts:[...conflicts],compatibility:input.compatibility??'unknown'};
}
export class RuleLibrary{
 constructor(lib,tx){this.lib=lib;this.tx=tx;}
 get db(){return this.lib.db;}
 lock(){return this.db.kind==='mysql'?' FOR UPDATE':'';}
 async sharedDirector(){const base=new URL('../../resources/skills/film-storyboard-director/',import.meta.url),files=[];for(const p of ['SKILL.md','references/storyboard-json.md','references/initialization.schema.json','references/original-director-brief.txt'])files.push({path:p,text:await fs.readFile(new URL(p,base),'utf8')});return{name:'电影导演分镜',use_kind:'main',source:'builtin',revision:'2026-11-04-json-v2',package:{format:'shiguang-rule-package-v1',entry:'SKILL.md',files,references:['references/storyboard-json.md','references/initialization.schema.json'],optionalReferences:['references/original-director-brief.txt'],compatibility:'storyboard',requires:[],conflicts:[]}};}
 async seed(){if(this.db.prepare('SELECT id FROM sb_rules WHERE id=?').get(BUILTIN_ID))return;this.import({...await this.sharedDirector(),id:BUILTIN_ID,mode:'new'},true);}

 head(id,lock=false){if(!idOK(id))throw fault('协议编号无效');const row=this.db.prepare('SELECT * FROM sb_rules WHERE id=?'+(lock?this.lock():'')).get(id);if(!row)throw fault('协议不存在',404);return row;}
 list(query={}){const q=String(query.q??'').slice(0,200).toLocaleLowerCase();return this.db.prepare('SELECT * FROM sb_rules WHERE deleted_at IS NULL ORDER BY last_used DESC,updated_at DESC,id').all().filter(r=>(!query.category_id||r.category_id===query.category_id)&&(!query.use_kind||r.use_kind===query.use_kind)&&(!query.favorite||r.favorite===1)&&(!q||(r.name+' '+r.source).toLocaleLowerCase().includes(q))).map(r=>({...r,favorite:r.favorite===1}));}
 version(id,version){const head=this.head(id);if(!Number.isSafeInteger(Number(version))||Number(version)<1)throw fault('协议版本无效');const row=this.db.prepare('SELECT * FROM sb_rule_versions WHERE rule_id=? AND version=?').get(id,Number(version));if(!row)throw fault('协议版本不存在',404);return {...row,name:head.name,use_kind:head.use_kind,source:row.source,package:JSON.parse(row.package_json),package_json:undefined};}
 import(input,builtin=false){const pack=validatePackage(input?.package),name=text(input.name,'协议名称',120,true),use=input.use_kind;if(!['main','style'].includes(use))bad('请选择主分镜或风格用途');const revision=text(input.revision??'自定义','规则修订',120,true);
  return this.tx(()=>{let id,version=1;const now=Date.now();
   if(input.mode==='version'){const old=this.head(input.rule_id,true);if(old.deleted_at!==null||old.current_version!==input.expected_version)throw fault('协议已更新，请核对后再保存版本',409);if(old.use_kind!==use)bad('规则版本不能更改协议用途');id=old.id;version=old.current_version+1;this.db.prepare('UPDATE sb_rules SET current_version=?,updated_at=? WHERE id=?').run(version,now,id);}
   else if(input.mode==='new'){id=builtin?input.id:randomUUID();if(input.category_id)this.category(input.category_id);this.db.prepare('INSERT INTO sb_rules VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,name,use,builtin?'builtin':text(input.source??'local-import','协议来源',120,true),input.category_id??null,0,1,null,null,now,now);}
   else bad('请明确选择新协议或新增版本');
   const contentHash=digest(pack);this.db.prepare('INSERT INTO sb_rule_versions VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),id,version,revision,canonical(pack),contentHash,now,now,builtin?'builtin':text(input.source??'local-edit','版本来源',120,true));return {rule:this.head(id),version:this.version(id,version),selected:false};
  });
 }
 metadata(id,input){return this.tx(()=>{const row=this.head(id,true);let category=row.category_id;if(Object.hasOwn(input,'category_id')){category=input.category_id;if(category!==null)this.category(category);}const favorite=input.favorite===undefined?row.favorite:input.favorite===true?1:0;this.db.prepare('UPDATE sb_rules SET category_id=?,favorite=?,updated_at=? WHERE id=?').run(category,favorite,Date.now(),id);return this.head(id);});}
 remove(id){return this.tx(()=>{this.head(id,true);this.db.prepare('UPDATE sb_rules SET deleted_at=?,updated_at=? WHERE id=?').run(Date.now(),Date.now(),id);return{deleted:true};});}
 categories(){return this.db.prepare('SELECT * FROM sb_rule_categories ORDER BY name,id').all();}
 category(id){if(!idOK(id))bad('分类编号无效');const row=this.db.prepare('SELECT * FROM sb_rule_categories WHERE id=?').get(id);if(!row)bad('分类不存在');return row;}
 saveCategory(input,id=null){return this.tx(()=>{const name=text(input.name,'分类名称',120,true),parent=input.parent_id??null;if(parent)this.category(parent);if(id){this.category(id);let cursor=parent;while(cursor){if(cursor===id)bad('分类不能形成循环');cursor=this.category(cursor).parent_id;}}
 const now=Date.now();if(id)this.db.prepare('UPDATE sb_rule_categories SET name=?,parent_id=?,updated_at=? WHERE id=?').run(name,parent,now,id);else{id=randomUUID();this.db.prepare('INSERT INTO sb_rule_categories VALUES(?,?,?,?,?)').run(id,name,parent,now,now);}return this.category(id);});}
 removeCategory(id){return this.tx(()=>{const old=this.category(id);this.db.prepare('UPDATE sb_rules SET category_id=NULL WHERE category_id=?').run(id);this.db.prepare('UPDATE sb_rule_categories SET parent_id=? WHERE parent_id=?').run(old.parent_id,id);this.db.prepare('DELETE FROM sb_rule_categories WHERE id=?').run(id);return{deleted:true,rulesRetained:true};});}
 selection(main,aux=[]){if(!main||!Array.isArray(aux)||aux.length>12)bad('请选择一个主协议及最多12个辅助协议');const refs=[main,...aux],seen=new Set(),result=[];
 for(const [n,ref]of refs.entries()){if(!ref||seen.has(ref.id))bad('不能重复选择协议');seen.add(ref.id);const head=this.head(ref.id);if(head.deleted_at!==null||head.use_kind!==(n===0?'main':'style'))bad('协议不可用或用途不匹配');const version=this.version(ref.id,ref.version),pack=validatePackage(version.package);if(pack.requires.some(c=>c!=='json-output'))throw fault('所选协议要求尚不支持的工具能力',400,{code:'RULE_CAPABILITY_UNSUPPORTED',field:'rules'});result.push({id:ref.id,version:version.version,revision:version.revision,name:head.name,source:version.source,use_kind:head.use_kind,contentHash:version.content_hash,compatibility:pack.compatibility,conflicts:pack.conflicts,files:[pack.entry,...pack.references].map(p=>({path:p,text:pack.files.find(f=>f.path===p).text}))});}
 for(const r of result)if(r.conflicts.some(id=>seen.has(id)))throw fault('所选协议声明彼此冲突，请调整选择',400,{code:'RULE_CONFLICT',field:'rules'});return result;
 }
 savePreset(input){if(input.project_id&&!idOK(input.project_id))bad('预设项目无效');const rules=this.selection(input.config?.mainRule,input.config?.auxiliaryRules??[]);const config={mainRule:{id:rules[0].id,version:rules[0].version},auxiliaryRules:rules.slice(1).map(r=>({id:r.id,version:r.version})),format:'2.0.0',aspect_ratio:text(input.config.aspect_ratio??'16:9','画幅',40,true),requirements:text(input.config.requirements??'','要求',20000),duration_seconds:input.config.duration_seconds??null,model:text(input.config.model??'','模型',200),effort:text(input.config.effort??'','等级',80)};const id=randomUUID(),now=Date.now();this.db.prepare('INSERT INTO sb_generation_presets VALUES(?,?,?,?,?,?)').run(id,text(input.name,'预设名称',120,true),input.project_id??null,canonical(config),now,now);return{id,config};}
 presets(projectId){return this.db.prepare('SELECT * FROM sb_generation_presets'+(projectId?' WHERE project_id=?':'')+' ORDER BY updated_at DESC,id').all(...(projectId?[projectId]:[])).map(r=>({...r,config:JSON.parse(r.config_json),config_json:undefined}));}
}
