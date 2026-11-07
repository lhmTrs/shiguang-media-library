import {fault,nameKey,idOK} from '../project-assets/model.mjs';
import {parseInitialization} from '../storyboard/import.mjs';
const lexicalNumbers=new WeakMap();
let lastNumberToken=null;
export const MAX_OUTPUT=4*1024*1024;
export const invalid=(path,message)=>{throw fault('分镜校验失败：'+path+'：'+message,400,{code:'STORYBOARD_OUTPUT_INVALID',errors:[{path,message}]});};
// Parse the entire JSON grammar, retaining duplicate-key and numeric lexical evidence
// that JSON.parse alone loses. No brace extraction, code-fence stripping or repairs.
export function strictJSON(source){
 if(typeof source!=='string'||Buffer.byteLength(source)>MAX_OUTPUT)invalid('$','结果为空、类型错误或超过4MiB');
 let at=0,nodes=0;const ws=()=>{while(/[ \t\n\r]/.test(source[at]??'x'))at++;};
 const fail=()=>invalid('$@'+at,'JSON语法错误、截断或非有限数字');
 function string(){const start=at++;while(at<source.length){const c=source[at++];if(c==='"'){try{return JSON.parse(source.slice(start,at));}catch{fail();}}if(c==='\\'){if(at>=source.length)fail();at++;}else if(c.charCodeAt(0)<32)fail();}fail();}
 function value(depth=0){lastNumberToken=null;if(depth>32||++nodes>300000)invalid('$','嵌套或节点数量超限');ws();const c=source[at];
  if(c==='"')return string();
  if(c==='{'){at++;ws();const o=Object.create(null),keys=new Set();if(source[at]==='}'){at++;return o;}for(;;){ws();if(source[at]!=='"')fail();const k=string();if(keys.has(k))invalid('$@'+at,'重复JSON键');keys.add(k);ws();if(source[at++]!==':')fail();o[k]=value(depth+1);if(typeof o[k]==='number'){const map=lexicalNumbers.get(o)??new Map();map.set(k,lastNumberToken);lexicalNumbers.set(o,map);}ws();const end=source[at++];if(end==='}')return o;if(end!==',')fail();}}
  if(c==='['){at++;ws();const a=[];if(source[at]===']'){at++;return a;}for(;;){a.push(value(depth+1));ws();const end=source[at++];if(end===']')return a;if(end!==',')fail();}}
  for(const [word,result]of [['true',true],['false',false],['null',null]])if(source.startsWith(word,at)){at+=word.length;return result;}
  const match=/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(at));if(!match)fail();at+=match[0].length;const num=Number(match[0]);if(!Number.isFinite(num))fail();lastNumberToken=match[0];return num;
 }
 const result=value();ws();if(at!==source.length)invalid('$@'+at,'JSON对象后存在额外内容');return result;
}
const str={type:'string'},num={type:'number'},arr=items=>({type:'array',items}),obj=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
// Conservative profile: no const/minItems/uniqueItems/pattern/arithmetic keywords.
// Semantic and size constraints remain mandatory in the independent validator.
const entry=obj({'编号':str,'名称':str,'描述':str,'年龄':str,'身份':str,'人物特点':str});
const dialogue=obj({'人物编号':str,'人物':str,'声源':str,'台词':str,'表演要求':str});
const continuation=obj({'来源镜号':str,'说明':str});
const shot=obj({'镜号':str,'开始秒':num,'结束秒':num,'时长秒':num,'景别与角度':str,'画面与人物动作':str,'摄影机设计':str,'人物编号':arr(str),'道具编号':arr(str),'场景编号':str,'声音与对白':obj({'环境与动作声':str,'对白':arr(dialogue),'承接对白':{anyOf:[continuation,{type:'null'}]}}),'剪辑衔接':str});
export const outputSchema=obj({'格式版本':{type:'string',enum:['2.0.0']},'完整分镜':{type:'boolean',enum:[true]},'项目名称':str,'故事核心':str,'画幅':str,'总时长秒':num,'素材清单':obj({'人物':arr(entry),'场景':arr(entry),'道具':arr(entry)}),'场景':arr(obj({'场次':{type:'integer'},'地点':str,'场景编号':str,'时间':str,'内外景':str,'空间设定':str,'开始秒':num,'结束秒':num,'时长秒':num,'镜头':arr(shot)}))});
export const PROFILE='storyboard-json-2.0.0-conservative-v1';
function exactInteger(value,raw,path){
 if(typeof value!=='number'||!Number.isSafeInteger(value)||typeof raw!=='string'||raw.length>80)invalid(path,'须为有界精确整数');
 const match=/^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(raw);if(!match)invalid(path,'整数词法无效');
 const exp=Number(match[4]??0);if(Math.abs(exp)>100)invalid(path,'整数指数超限');const coefficient=BigInt(match[2]+(match[3]??'')),scale=(match[3]?.length??0)-exp;
 let integer;if(scale>0){const divisor=10n**BigInt(scale);if(coefficient%divisor!==0n)invalid(path,'原始数值不是整数');integer=coefficient/divisor;}else integer=coefficient*10n**BigInt(-scale);
 if(match[1])integer=-integer;if(integer!==BigInt(value))invalid(path,'整数不能依赖浮点舍入');
}
function shapeType(value,type){return type==='null'?value===null:type==='object'?value!==null&&typeof value==='object'&&!Array.isArray(value):type==='array'?Array.isArray(value):type==='integer'?Number.isSafeInteger(value):type==='number'?typeof value==='number'&&Number.isFinite(value):typeof value===type;}
// Enforce the same bounded structural profile actually supplied to turn/start.
// The legacy manual importer remains permissive; it is never our schema validator.
function validateShape(value,schema,path='$',rawNumber){
 if(schema.anyOf){const branch=schema.anyOf.find(s=>shapeType(value,s.type));if(!branch)invalid(path,'类型不符合输出Schema');return validateShape(value,branch,path,rawNumber);}
 if(!shapeType(value,schema.type))invalid(path,'类型须为 '+schema.type);
 if(schema.enum&&!schema.enum.includes(value))invalid(path,'值不符合输出Schema');
 if(schema.type==='integer')exactInteger(value,rawNumber,path);
 if(schema.type==='object'){
  for(const key of schema.required)if(!Object.hasOwn(value,key))invalid(path+'.'+key,'缺少输出Schema必需字段');
  for(const [key,item]of Object.entries(value)){const child=schema.properties[key];if(!child)invalid(path+'.'+key,'输出Schema不允许此字段');validateShape(item,child,path+'.'+key,lexicalNumbers.get(value)?.get(key));}
 }else if(schema.type==='array')value.forEach((item,index)=>validateShape(item,schema.items,path+'['+index+']',lexicalNumbers.get(value)?.get(index)));
}

const record=(v,p)=>{if(!v||typeof v!=='object'||Array.isArray(v))invalid(p,'须为对象');};
const text=(v,p,max=30000,required=false)=>{if(typeof v!=='string'||v.length>max||v.includes('\0')||(required&&!v.trim()))invalid(p,'文本缺失或长度无效');};
const array=(v,p,max=1000,min=0)=>{if(!Array.isArray(v)||v.length>max||v.length<min)invalid(p,'数组缺失或数量无效');};
const ms=(owner,key,p,positive=false)=>{const v=owner[key],raw=lexicalNumbers.get(owner)?.get(key)??String(v);if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>86400||(positive&&v===0)||raw.length>80)invalid(p,'须为最多三位小数的有效秒数');const m=/^-?(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(raw);if(!m)invalid(p,'秒数无效');const exp=Number(m[3]??0);if(Math.abs(exp)>100)invalid(p,'秒数精度无效');const digits=BigInt(m[1]+(m[2]??'')),scale=(m[2]?.length??0)-exp;let ticks;if(scale>3){const unit=10n**BigInt(scale-3);if(digits%unit!==0n)invalid(p,'秒数超过毫秒精度');ticks=digits/unit;}else ticks=digits*10n**BigInt(3-scale);return Number(ticks);};
const local=(v,p)=>{text(v,p,160,true);if(idOK(v)||!/^[-A-Za-z0-9_]+$/.test(v))invalid(p,'只允许本文件局部编号，不允许数据库ID');return v;};
export function validateOutput(source){
 const doc=strictJSON(source);validateShape(doc,outputSchema);record(doc,'$');
 if(doc['格式版本']!=='2.0.0'||doc['完整分镜']!==true)invalid('$','需要完整2.0.0分镜');
 text(doc['项目名称'],'项目名称',1000,true);text(doc['故事核心'],'故事核心');text(doc['画幅'],'画幅',40,true);record(doc['素材清单'],'素材清单');
 const manifests={};let allEntries=0;
 for(const kind of ['人物','场景','道具']){const rows=doc['素材清单'][kind];array(rows,'素材清单.'+kind,2000);const ids=new Map(),names=new Set();for(const [i,e]of rows.entries()){const p=`素材清单.${kind}[${i}]`;record(e,p);const id=local(e['编号'],p+'.编号');text(e['名称'],p+'.名称',120,true);const nk=nameKey(e['名称']);if(ids.has(id)||names.has(nk))invalid(p,'同类名称或编号重复');ids.set(id,e);names.add(nk);for(const k of ['描述','身份','人物特点'])if(e[k]!==undefined)text(e[k],p+'.'+k);if(e['年龄']!==undefined&&!(typeof e['年龄']==='number'&&Number.isFinite(e['年龄'])))text(e['年龄'],p+'.年龄',80);if(e['姓名']!==undefined&&nameKey(e['姓名'])!==nk)invalid(p,'姓名和名称不一致');}manifests[kind]=ids;allEntries+=rows.length;}
 if(allEntries>4000)invalid('素材清单','总数超限');
 if(doc['人物']!==undefined){array(doc['人物'],'人物',2000);const names=new Set([...manifests['人物'].values()].map(e=>nameKey(e['名称']))),seen=new Set();for(const e of doc['人物']){record(e,'人物');text(e['姓名'],'人物.姓名',120,true);const k=nameKey(e['姓名']);if(!names.has(k)||seen.has(k))invalid('人物','资料重复或未列入人物清单');seen.add(k);}}
 const resolve=(kind,id,p)=>{local(id,p);if(!manifests[kind].has(id))invalid(p,kind+'编号不存在');return manifests[kind].get(id);};
 array(doc['场景'],'场景',500,1);const shots=new Map();let cursor=0,totalShots=0;
 for(const [si,s]of doc['场景'].entries()){
  const p=`场次 ${si+1}`;record(s,p);if(s['场次']!==si+1)invalid(p,'场次须从1连续排列');resolve('场景',s['场景编号'],p+'.场景编号');for(const k of ['地点','时间','内外景','空间设定'])text(s[k],p+'.'+k,30000,k==='地点');
  const sceneStart=ms(s,'开始秒',p+'.开始秒');if(sceneStart!==cursor)invalid(p,'场开始时间不连续');array(s['镜头'],p+'.镜头',5000,1);
  for(const q of s['镜头']){
   record(q,p+'.镜头');const id=local(q['镜号'],p+'.镜号'),qp=p+' / 镜 '+id;
   // The legacy continuation resolver pads numbers; reject aliases like 1/01 too.
   const number=id.padStart(2,'0');if(shots.has(number))invalid(qp,'重复镜号');
   if(!/^\d+$/.test(id)||BigInt(id)!==BigInt(totalShots+1))invalid(qp,'镜号须全片唯一且连续递增');
   const start=ms(q,'开始秒',qp+'.开始秒'),duration=ms(q,'时长秒',qp+'.时长秒',true),end=ms(q,'结束秒',qp+'.结束秒');if(start!==cursor||end!==start+duration)invalid(qp,'开始/结束/时长与全片时间轴不一致');cursor=end;
   for(const k of ['景别与角度','画面与人物动作','摄影机设计','剪辑衔接'])text(q[k],qp+'.'+k,30000,['画面与人物动作','摄影机设计'].includes(k));
   for(const [field,kind]of [['人物编号','人物'],['道具编号','道具']]){array(q[field],qp+'.'+field,2000);if(new Set(q[field]).size!==q[field].length)invalid(qp+'.'+field,'引用重复');for(const ref of q[field])resolve(kind,ref,qp+'.'+field);}
   resolve('场景',q['场景编号'],qp+'.场景编号');record(q['声音与对白'],qp+'.声音与对白');const audio=q['声音与对白'];text(audio['环境与动作声'],qp+'.环境与动作声');array(audio['对白'],qp+'.对白',200);
   for(const d of audio['对白']){record(d,qp+'.对白');const character=resolve('人物',d['人物编号'],qp+'.对白.人物编号');text(d['人物'],qp+'.对白.人物',120,true);if(nameKey(d['人物'])!==nameKey(character['名称'])||!q['人物编号'].includes(d['人物编号']))invalid(qp+'.对白','姓名、编号或本镜人物关联不一致');for(const k of ['声源','台词','表演要求'])text(d[k],qp+'.对白.'+k,30000,k==='台词');}
   const continuation=audio['承接对白'];if(continuation!==undefined&&continuation!==null){record(continuation,qp+'.承接对白');if(Object.keys(continuation).some(k=>!['来源镜号','说明'].includes(k)))invalid(qp+'.承接对白','仅支持来源镜最后一句对白');local(continuation['来源镜号'],qp+'.承接对白.来源镜号');const from=shots.get(continuation['来源镜号'].padStart(2,'0'));if(!from?.['声音与对白']['对白'].length)invalid(qp+'.承接对白','来源须为先前有对白的镜头，且仅承接最后一句');const last=from['声音与对白']['对白'].at(-1);if(!q['人物编号'].includes(last['人物编号']))invalid(qp+'.承接对白','承接声源人物须列入本镜关联');if(audio['对白'].some(d=>d['人物编号']===last['人物编号']&&d['台词']===last['台词']))invalid(qp+'.承接对白','同一跨镜对白不能重复记为新对白');text(continuation['说明'],qp+'.承接对白.说明',30000,true);}
   shots.set(number,q);totalShots++;if(totalShots>5000)invalid(qp,'全片镜头数超过5000');
  }
  if(ms(s,'结束秒',p+'.结束秒')!==cursor||ms(s,'时长秒',p+'.时长秒',true)!==cursor-sceneStart)invalid(p,'场范围或时长与镜头合计不一致');
 }
 if(ms(doc,'总时长秒','总时长秒',true)!==cursor)invalid('总时长秒','与全片镜头合计不一致');
 // Reject unknown persistent IDs/paths even nested in extra keys. Bounded parser
 // already limits nodes; field contracts are the source of import authority.
 function forbidden(v,p='$'){if(!v||typeof v!=='object')return;for(const [k,x]of Object.entries(v)){if(/^(?:id|project_id|document_id|request_id|asset_id|schema_version|path|file_path|source|asset_manifest|__proto__|constructor|prototype)$/i.test(k))invalid(p+'.'+k,'不接受数据库ID、路径或外部导入字段');if(typeof x==='string'&&x.length>30000)invalid(p+'.'+k,'字段过长');forbidden(x,p+'.'+k);}}
 forbidden(doc);const plain=JSON.parse(JSON.stringify(doc)),parsed=parseInitialization(plain,{filename:'Codex分镜.json',timing:'duration'});
 if(parsed.warnings.some(w=>w.kind==='timing'))invalid('$','不允许导入器修正时间轴');
 return {source:plain,summary:parsed.summary};
}
