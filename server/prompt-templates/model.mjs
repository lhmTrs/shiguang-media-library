export const FIELD_TYPES = ['text','textarea','number','select','multiselect'];
const forbidden = new Set(['__proto__','constructor','prototype']);
export function fault(message,status=400){return Object.assign(Error(message),{status});}
export const canonical = value => JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export function references(body){return [...new Set([...body.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map(m=>m[1].trim()))];}
const text=(v,max,label,required=false)=>{if(typeof v!=='string'||v.length>max||(required&&!v.trim())||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v))throw fault(label+'格式无效');return v;};
export function definition(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw fault('模板格式无效');
 const name=text(input.name,120,'模板名称',true).trim(),description=text(input.description??'',1000,'说明'),category=text(input.category??'通用',80,'分类',true),body=text(input.body,50000,'模板正文',true);
 if(!Array.isArray(input.fields)||input.fields.length>40)throw fault('最多支持 40 个输入项');const keys=new Set();
 const fields=input.fields.map((f,index)=>{
  const label=typeof f?.key==='string'?'「'+f.key.slice(0,40)+'」':'第 '+(index+1)+' 个输入项';
  if(!f||typeof f.key!=='string'||!f.key.trim()||!/^[\p{L}\p{N}_ /／]{1,40}$/u.test(f.key))throw fault('输入项'+label+'名称无效：请使用 1–40 个中文、字母、数字、空格、下划线或斜杠（/、／）');
  if(forbidden.has(f.key))throw fault('输入项'+label+'使用了系统保留名称，请更换');
  if(keys.has(f.key))throw fault('输入项名称重复：'+label);
  if(!FIELD_TYPES.includes(f.type))throw fault('输入项'+label+'类型无效，请重新选择');
  if(typeof f.required!=='boolean')throw fault('输入项'+label+'必填设置无效，请重新勾选');
  keys.add(f.key);
  const field={key:f.key,type:f.type,required:f.required,help:text(f.help??'',500,'字段说明')};
  if(['select','multiselect'].includes(f.type)){
   if(!Array.isArray(f.options)||!f.options.length||f.options.length>50||f.options.some(v=>typeof v!=='string'||!v.trim()||v.length>200)||new Set(f.options).size!==f.options.length)throw fault('选择字段的选项无效');field.options=[...f.options];
  }
  if(f.type==='multiselect'){
   const value=f.default??[];if(!Array.isArray(value)||value.some(v=>!field.options.includes(v))||new Set(value).size!==value.length)throw fault('多选默认值无效');field.default=[...value];
  }else{
   field.default=text(f.default??'',30000,'默认值');
   if(f.type==='select'&&field.default&&!field.options.includes(field.default))throw fault('默认值不在选项中');
   if(f.type==='number'&&field.default&&(!Number.isFinite(Number(field.default))||Number(field.default)<=0))throw fault('数字默认值须大于 0');
  }return field;
 });
 for(const key of references(body))if(!keys.has(key))throw fault('未配置输入项：'+key);
 if(body.replace(/\{\{\s*([^{}]+?)\s*\}\}/g,'').includes('{{'))throw fault('变量标记不完整');
 return {name,description,category,body,fields};
}
export function defaults(t){return Object.fromEntries(t.fields.map(f=>[f.key,structuredClone(f.default)]));}
export function compile(input,values={}){
 const t=definition(input);if(!values||typeof values!=='object'||Array.isArray(values))throw fault('输入内容格式无效');const clean={},errors=[];
 for(const f of t.fields){let v=Object.hasOwn(values,f.key)?values[f.key]:f.default;
  if(f.type==='multiselect'){
   if(!Array.isArray(v)||v.some(x=>!f.options.includes(x))||new Set(v).size!==v.length){errors.push(f.key+'的选项无效');v=[];}clean[f.key]=[...v];if(f.required&&!v.length)errors.push('请选择'+f.key);
  }else{if(typeof v!=='string'||v.length>100000){errors.push(f.key+'内容无效或过长');v='';}clean[f.key]=v;if(f.required&&!v.trim())errors.push('请填写'+f.key);else if(v.trim()&&f.type==='number'&&(!Number.isFinite(Number(v))||Number(v)<=0))errors.push(f.key+'须为大于 0 的数字');else if(v&&f.type==='select'&&!f.options.includes(v))errors.push(f.key+'的选项无效');}
 }
 const display=key=>Array.isArray(clean[key])?clean[key].join('、'):String(clean[key]??'');
 const body=t.body.split(/\n\s*\n/).filter(block=>{const keys=references(block);return !keys.length||!keys.every(k=>!t.fields.find(f=>f.key===k).required&&!display(k).trim());}).join('\n\n');
 const segments=[];let last=0;for(const m of body.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)){segments.push({text:body.slice(last,m.index)});const key=m[1].trim(),value=display(key);segments.push({text:value.trim()?value:'[待填写：'+key+']',variable:true,missing:!value.trim()});last=m.index+m[0].length;}segments.push({text:body.slice(last)});
 return {values:clean,errors,segments,prompt:segments.map(s=>s.text).join('')};
}
