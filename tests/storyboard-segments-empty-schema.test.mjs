import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {parseInitialization} from '../server/storyboard/import.mjs';
import {validateOutput,outputSchema} from '../server/storyboard-generation/validation.mjs';

// Interpret the keywords present in these published documents, using their actual
// constraints rather than checking that copies or minItems literals match.
function schemaErrors(value,schema,path='$') {
 const errors=[],add=message=>errors.push(path+':'+message);
 const matches=(v,t)=>t==='array'?Array.isArray(v):t==='object'?v!==null&&typeof v==='object'&&!Array.isArray(v):t==='integer'?Number.isSafeInteger(v):t==='number'?typeof v==='number'&&Number.isFinite(v):t==='null'?v===null:typeof v===t;
 if(schema.anyOf){if(!schema.anyOf.some(s=>schemaErrors(value,s,path).length===0))add('anyOf');return errors;}
 if(schema.type&&![schema.type].flat().some(t=>matches(value,t))){add('type');return errors;}
 if('const'in schema&&value!==schema.const)add('const');
 if(schema.enum&&!schema.enum.includes(value))add('enum');
 if(typeof value==='string'){
  if(schema.minLength!==undefined&&value.length<schema.minLength)add('minLength');
  if(schema.maxLength!==undefined&&value.length>schema.maxLength)add('maxLength');
  if(schema.pattern&&!new RegExp(schema.pattern).test(value))add('pattern');
 }
 if(typeof value==='number'){
  if(schema.minimum!==undefined&&value<schema.minimum)add('minimum');
  if(schema.exclusiveMinimum!==undefined&&value<=schema.exclusiveMinimum)add('exclusiveMinimum');
 }
 if(Array.isArray(value)){
  if(schema.minItems!==undefined&&value.length<schema.minItems)add('minItems');
  if(schema.maxItems!==undefined&&value.length>schema.maxItems)add('maxItems');
  if(schema.items)for(const [i,item]of value.entries())errors.push(...schemaErrors(item,schema.items,path+'['+i+']'));
 }else if(value&&typeof value==='object'){
  for(const key of schema.required??[])if(!Object.hasOwn(value,key))add('required '+key);
  for(const [key,item]of Object.entries(value)){if(schema.properties?.[key])errors.push(...schemaErrors(item,schema.properties[key],path+'.'+key));else if(schema.additionalProperties===false)add('additionalProperties '+key);}
 }
 return errors;
}
const scene=()=>({'场次':1,'地点':'空房','场景编号':'S1','时间':'白天','内外景':'内','空间设定':'合成','开始秒':0,'结束秒':0,'时长秒':0,'镜头':[]});
const board=(scenes=[])=>({'格式版本':'2.0.0','完整分镜':true,'项目名称':'合成空稿','故事核心':'','画幅':'16:9','总时长秒':3,'素材清单':{'人物':[],'场景':[{'编号':'S1','名称':'空房','描述':'','年龄':'','身份':'','人物特点':''}],'道具':[]},'分段':[],'分割模式':{'模式':'seedance_2_5','自定义上限毫秒':null},'场景':scenes});
const published=await Promise.all(['../server/storyboard/initialization.schema.json','../resources/skills/film-storyboard-director/references/initialization.schema.json'].map(async path=>JSON.parse(await fs.readFile(new URL(path,import.meta.url),'utf8'))));
function assertAllSchemas(value){for(const schema of [...published,outputSchema])assert.deepEqual(schemaErrors(value,schema),[]);}
function populated(){const p=board([scene()]),s=p['场景'][0];s['结束秒']=s['时长秒']=3;s['镜头']=[{'镜号':'01','开始秒':0,'结束秒':3,'时长秒':3,'景别与角度':'全景','画面与人物动作':'灯亮','摄影机设计':'固定','人物编号':[],'道具编号':[],'场景编号':'S1','声音与对白':{'环境与动作声':'风声','对白':[],'承接对白':null},'剪辑衔接':''}];p['分段']=[{'段':'A','起始镜号':'01'}];return p;}

for(const [label,scenes]of [['0场0镜',[]],['1场0镜',[scene()]]])test(label+' passes actual published/generation schemas and both parsers',()=>{
 const p=board(scenes);assertAllSchemas(p);assert.equal(parseInitialization(p).summary.shots,0);assert.deepEqual(parseInitialization(p).project.segments,[]);assert.equal(validateOutput(JSON.stringify(p)).summary.shots,0);
 // Negative control: the former minItems=1 rejects these exact arrays.
 for(const schema of published){const previous=structuredClone(schema);if(scenes.length)previous.properties['场景'].items.properties['镜头'].minItems=1;else previous.properties['场景'].minItems=1;assert.ok(schemaErrors(p,previous).some(e=>e.includes('minItems')));}
});
test('empty scene can coexist with real shots without relaxing nonempty timeline or segment coverage',()=>{
 const p=populated();p['场景'].unshift(scene());p['场景'][1]['场次']=2;assertAllSchemas(p);assert.equal(validateOutput(JSON.stringify(p)).summary.shots,1);
 const badTime=structuredClone(p);badTime['场景'][0]['结束秒']=1;assert.throws(()=>validateOutput(JSON.stringify(badTime)));
 const mismatch=structuredClone(p);mismatch['总时长秒']=4;assert.throws(()=>validateOutput(JSON.stringify(mismatch)));
 for(const segments of [[],[{'段':'A','起始镜号':'02'}],[{'段':'A','起始镜号':'01'},{'段':'B','起始镜号':'01'}]]){const invalid=structuredClone(p);invalid['分段']=segments;assert.throws(()=>parseInitialization(invalid));assert.throws(()=>validateOutput(JSON.stringify(invalid)));}
});
test('required segments, valid names, positive target and strict empty scene ranges remain enforced',()=>{
 const missing=board();delete missing['分段'];for(const schema of [...published,outputSchema])assert.ok(schemaErrors(missing,schema).length);assert.throws(()=>parseInitialization(missing),{code:'SEGMENTS_REQUIRED'});assert.throws(()=>validateOutput(JSON.stringify(missing)));
 const zero=board();zero['总时长秒']=0;for(const schema of published)assert.ok(schemaErrors(zero,schema).length);assert.throws(()=>parseInitialization(zero));assert.throws(()=>validateOutput(JSON.stringify(zero)));
 const name=populated();name['分段'][0]['段']='A0';for(const schema of published)assert.ok(schemaErrors(name,schema).length);assert.throws(()=>parseInitialization(name));assert.throws(()=>validateOutput(JSON.stringify(name)));
 const phantom=board();phantom['分段']=[{'段':'B','起始镜号':'01'}];assert.throws(()=>parseInitialization(phantom));assert.throws(()=>validateOutput(JSON.stringify(phantom)));
 const range=board([scene()]);range['场景'][0]['时长秒']=1;assert.throws(()=>validateOutput(JSON.stringify(range)));
});
