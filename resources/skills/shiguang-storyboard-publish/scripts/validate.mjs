// Published JSON-schema keywords used by the local app; server validates again.
export function schemaErrors(value, schema) {
 const errors=[];
 const type=(v,t)=>t==='object'?v!==null&&typeof v==='object'&&!Array.isArray(v):t==='array'?Array.isArray(v):t==='integer'?Number.isSafeInteger(v):t==='number'?typeof v==='number'&&Number.isFinite(v):t==='null'?v===null:typeof v===t;
 function visit(v,s,p,out){
  if(s.$ref){if(!s.$ref.startsWith('#/'))throw Error('不支持外部 schema 引用');s=s.$ref.slice(2).split('/').reduce((a,k)=>a[k.replaceAll('~1','/').replaceAll('~0','~')],schema);}
  if(s.type&&![s.type].flat().some(t=>type(v,t))){out.push({path:p,message:'字段类型不符合当前格式'});return;}
  if('const'in s&&v!==s.const)out.push({path:p,message:'固定值不符合当前格式'});
  if(s.enum&&!s.enum.includes(v))out.push({path:p,message:'值不在当前格式允许范围'});
  if(s.anyOf&&!s.anyOf.some(a=>{const e=[];visit(v,a,p,e);return !e.length;}))out.push({path:p,message:'缺少所需字段组合'});
  if(typeof v==='number')for(const [k,bad]of [['minimum',n=>v<n],['maximum',n=>v>n],['exclusiveMinimum',n=>v<=n],['exclusiveMaximum',n=>v>=n]])if(s[k]!==undefined&&bad(s[k]))out.push({path:p,message:'数值越界：'+k});
  if(typeof v==='string'&&((s.minLength!==undefined&&[...v].length<s.minLength)||(s.maxLength!==undefined&&[...v].length>s.maxLength)||(s.pattern&&!new RegExp(s.pattern).test(v))))out.push({path:p,message:'文本长度或格式不符合约定'});
  if(type(v,'object')){for(const k of s.required??[])if(!Object.hasOwn(v,k))out.push({path:p+'.'+k,message:'缺少必填字段'});for(const [k,x]of Object.entries(v)){if(s.properties?.[k])visit(x,s.properties[k],p+'.'+k,out);else if(s.additionalProperties===false)out.push({path:p+'.'+k,message:'不允许的字段'});}}
  if(Array.isArray(v)){if((s.minItems!==undefined&&v.length<s.minItems)||(s.maxItems!==undefined&&v.length>s.maxItems))out.push({path:p,message:'数组数量不符合约定'});if(s.uniqueItems&&new Set(v.map(x=>JSON.stringify(x))).size!==v.length)out.push({path:p,message:'数组元素重复'});if(s.items)v.forEach((x,i)=>visit(x,s.items,p+'['+i+']',out));}
 }
 visit(value,schema,'$',errors);return errors;
}
export function initializationErrors(source){
 const errors=[],add=(path,message)=>errors.push({path,message}),names=new Map(),ids=new Map();
 for(const kind of ['人物','场景','道具']){
  const list=source.素材清单[kind],seen=new Set(),known=new Map();
  for(const [i,a]of list.entries()){const name=a.名称.normalize('NFC').trim().toLowerCase();if(seen.has(a.编号)||known.has(name))add('$.素材清单.'+kind+'['+i+']','同类编号或名称重复');seen.add(a.编号);known.set(name,a.编号);}
  names.set(kind,known);ids.set(kind,seen);
 }
 const refs=(values,kind,p)=>{for(const v of values??[])if(!ids.get(kind).has(v))add(p,'引用了素材清单以外的'+kind+'编号：'+v);};
 const numbers=new Set(),scenes=new Set();let end=0;
 const ms=v=>Math.round(v*1000),near=(a,b)=>Math.abs(a-b)<=1;
 for(const [si,s]of source.场景.entries()){
  const sp='$.场景['+si+']',start=end;
  if(s.场次!==undefined){if(scenes.has(String(s.场次)))add(sp+'.场次','场次重复');scenes.add(String(s.场次));}
  if(s.场景编号)refs([s.场景编号],'场景',sp+'.场景编号');
  for(const [qi,q]of s.镜头.entries()){
   const p=sp+'.镜头['+qi+']',n=String(q.镜号).trim().replace(/^0+(?=\d)/,'');if(numbers.has(n))add(p+'.镜号','镜号重复');numbers.add(n);
   if(q.开始秒!==undefined&&!near(ms(q.开始秒),end))add(p+'.开始秒','与前镜累计时长不连续');
   end+=ms(q.时长秒);if(q.结束秒!==undefined&&!near(ms(q.结束秒),end))add(p+'.结束秒','与镜头时长不一致');
   refs(q.人物编号,'人物',p+'.人物编号');refs(q.道具编号,'道具',p+'.道具编号');if(q.场景编号)refs([q.场景编号],'场景',p+'.场景编号');
   for(const [di,d]of(q.声音与对白?.对白??[]).entries()){
    const dp=p+'.声音与对白.对白['+di+']';if(d.人物编号)refs([d.人物编号],'人物',dp+'.人物编号');
    if(d.人物){const known=names.get('人物').get(d.人物.normalize('NFC').trim().toLowerCase());if(!known||d.人物编号&&known!==d.人物编号)add(dp,'对白人物名称与素材清单/编号不一致');}
   }
  }
  for(const [key,expected]of [['开始秒',start],['结束秒',end],['时长秒',end-start]])if(s[key]!==undefined&&(!Number.isFinite(s[key])||!near(ms(s[key]),expected)))add(sp+'.'+key,'场次时间与镜头累计时长不一致');
 }
 if(!near(ms(source.总时长秒),end))add('$.总时长秒','与全部镜头总时长不一致');return errors;
}
