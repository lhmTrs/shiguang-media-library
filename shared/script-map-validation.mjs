// Browser and server share structure checks; ownership and frozen text stay server-side.
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export function validateScriptMap(g){
 const issues=[];const issue=(code,path,message,severity='error')=>issues.push({code,path,message,severity});
 const obj=(v,p,keys)=>{if(!record(v)){issue('TYPE',p,'需要对象');return false;}for(const k of Object.keys(v))if(!keys.includes(k))issue('FIELD',p+'.'+k,'未知字段');return true;};
 const str=(v,p,max=200,required=true)=>{if(typeof v!=='string'||v.length>max||(required&&!v.trim())||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v))issue('TEXT',p,'文本格式或长度无效');};
 const list=(v,p,max)=>{if(!Array.isArray(v)||v.length>max){issue('TYPE',p,'数组格式或数量无效');return [];}return v;};
 const positive=v=>Number.isSafeInteger(v)&&v>0&&v<=1000000;
 if(!obj(g,'graph',['schemaVersion','kind','title','subtitle','madeBy','gist','sources','versions','lanes','bands','nodes','edges']))return {issues};
 if(g.schemaVersion!==1)issue('SCHEMA','graph.schemaVersion','不支持的数据版本');if(!['single','diff'].includes(g.kind))issue('KIND','graph.kind','图类型无效');
 for(const k of ['title','subtitle','madeBy','gist'])if(g[k]!==undefined||k==='title')str(g[k],'graph.'+k,k==='gist'?10000:1000,k==='title');
 const sources=new Set(),lanes=new Map(),nodes=new Map(),slots=new Set();
 list(g.sources,'graph.sources',100).forEach((s,i)=>{const p=`graph.sources[${i}]`;if(!obj(s,p,['key','sourceId','label']))return;str(s.key,p+'.key',80);str(s.sourceId,p+'.sourceId',80);if(s.label!==undefined)str(s.label,p+'.label',200);if(sources.has(s.key))issue('DUPLICATE',p+'.key','来源别名重复');sources.add(s.key);});
 list(g.lanes,'graph.lanes',50).forEach((l,i)=>{const p=`graph.lanes[${i}]`;if(!obj(l,p,['id','name','hero']))return;str(l.id,p+'.id',80);str(l.name,p+'.name');if(l.hero!==undefined&&typeof l.hero!=='boolean')issue('TYPE',p+'.hero','需要布尔值');if(lanes.has(l.id))issue('DUPLICATE',p+'.id','泳道重复');lanes.set(l.id,l);});
 const heroes=[...lanes.values()].filter(l=>l.hero);if(heroes.length!==1||Math.abs([...lanes.keys()].indexOf(heroes[0]?.id)-(lanes.size-1)/2)>.5)issue('HERO','graph.lanes','主角泳道应为一条且居中','warning');
 if(g.kind==='diff'){
  if(obj(g.versions,'graph.versions',['v1','v2']))for(const side of ['v1','v2']){const v=g.versions[side],p='graph.versions.'+side;if(obj(v,p,['label','source','short'])){str(v.label,p+'.label');if(v.short!==undefined)str(v.short,p+'.short',40);if(!sources.has(v.source))issue('SOURCE',p+'.source','未知来源');}}
 }
 const refs=(a,p,side)=>list(a,p,100).forEach((r,i)=>{const q=`${p}[${i}]`;if(!obj(r,q,['source','start','end','quote']))return;if(!sources.has(r.source))issue('SOURCE',q+'.source','未知来源');if(side&&r.source!==g.versions?.[side]?.source)issue('SIDE',q+'.source','引用了另一侧来源');if(!positive(r.start)||!positive(r.end??r.start)||(r.end??r.start)<r.start)issue('RANGE',q,'行号范围无效');str(r.quote,q+'.quote',1000);if((r.end??r.start)-r.start>=10)issue('SPAN',q,'引用跨度超过10行','warning');});
 list(g.nodes,'graph.nodes',2000).forEach((n,i)=>{const p=`graph.nodes[${i}]`;if(!obj(n,p,['id','lane','row','kind','label','refs','ai','change','old','new','what','why']))return;
 str(n.id,p+'.id',80);if(nodes.has(n.id))issue('DUPLICATE',p+'.id','节点重复');nodes.set(n.id,n);if(!lanes.has(n.lane))issue('LANE',p+'.lane','泳道不存在');if(!positive(n.row))issue('ROW',p+'.row','行必须为正整数');const slot=JSON.stringify([n.lane,n.row]);if(slots.has(slot))issue('SLOT',p,'同泳道同行重复');slots.add(slot);
 if(!['self','seen','away'].includes(n.kind))issue('KIND',p+'.kind','节点类型无效');const labels=list(n.label,p+'.label',20);labels.forEach((v,j)=>str(v,`${p}.label[${j}]`,1000));if(!labels.length)issue('LABEL',p+'.label','标签不能为空');if(labels.length>2||labels.some(v=>typeof v==='string'&&[...v].reduce((s,c)=>s+(/^[\x20-\x7e]$/.test(c)?.5:1),0)>(lanes.get(n.lane)?.hero?10:7)))issue('LABEL_LENGTH',p+'.label','标签超过建议长度','warning');
 for(const k of ['what','why'])if(n[k]!==undefined)str(n[k],p+'.'+k,10000,false);
 if(n.ai!==undefined&&obj(n.ai,p+'.ai',['what','why','unsure'])){for(const k of ['what','why','unsure'])if(n.ai[k]!==undefined)str(n.ai[k],p+'.ai.'+k,10000,false);if(!n.ai.why)issue('AI_REASON',p+'.ai.why','AI补充建议说明原因','warning');}
 if(g.kind==='single'){if(n.change!==undefined||n.old!==undefined||n.new!==undefined)issue('SIDE',p,'单版图不含改动侧');if(n.refs!==undefined)refs(n.refs,p+'.refs');if(!n.refs?.length&&!n.ai)issue('NO_REFERENCE',p+'.refs','剧本节点没有引文','warning');}
 else {if(n.refs!==undefined)issue('SIDE',p+'.refs','对比图使用old/new');if(n.change!==undefined&&!['del','new','chg','minor'].includes(n.change))issue('CHANGE',p+'.change','改动类型无效');if(n.old!==undefined)refs(n.old,p+'.old','v1');if(n.new!==undefined)refs(n.new,p+'.new','v2');const old=n.old?.length>0,ne=n.new?.length>0;if(n.change==='del'?(!old||ne):n.change==='new'?(!ne||old):['chg','minor'].includes(n.change)?(!old||!ne):!ne)issue('SIDES',p,'改动两侧引用不完整');if(n.change&&(!n.what||!n.why))issue('CHANGE_REASON',p,'改动建议说明what/why','warning');}
 });
 list(g.bands??[],'graph.bands',1000).forEach((b,i)=>{const p=`graph.bands[${i}]`;if(!obj(b,p,['row','label']))return;if(!positive(b.row))issue('ROW',p+'.row','行必须为正整数');str(b.label,p+'.label',1000);if([...nodes.values()].some(n=>n.row===b.row))issue('BAND',p,'场次带与框同行','warning');});
 list(g.edges,'graph.edges',6000).forEach((e,i)=>{const p=`graph.edges[${i}]`;if(!obj(e,p,['from','to','route','offset']))return;if(!nodes.has(e.from)||!nodes.has(e.to))issue('ENDPOINT',p,'箭头端点不存在');if(e.route!==undefined&&!['auto','v','h','d','hv','vh','leader'].includes(e.route))issue('ROUTE',p+'.route','走线无效');if(e.offset!==undefined&&(!Number.isFinite(e.offset)||e.offset<0||e.offset>1||!['hv','vh'].includes(e.route)))issue('OFFSET',p+'.offset','折线偏移须为0到1');if(nodes.get(e.to)?.row<nodes.get(e.from)?.row)issue('BACKWARD',p,'箭头向前回指','warning');});
 return {issues};
}
