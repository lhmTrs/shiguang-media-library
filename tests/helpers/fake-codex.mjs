// Disposable JSON-RPC peer for tests; never connects to a model service.
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import {deflateSync} from 'node:zlib';
const send=packet=>process.stdout.write(JSON.stringify(packet)+'\n');
const models=[
 {model:'synthetic-a',displayName:'验收模型 A',description:'合成模型，支持低/高/最高',isDefault:true,hidden:false,defaultReasoningEffort:'high',supportedReasoningEfforts:['low','high','max'].map(reasoningEffort=>({reasoningEffort,description:'合成推理强度 '+reasoningEffort})),inputModalities:['text','image']},
 {model:'synthetic-b',displayName:'验收模型 B',description:'合成模型，仅中等级',isDefault:false,hidden:false,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'中等级'}],inputModalities:['text']},
];
function crc(buffer){let value=0xffffffff;for(const byte of buffer){value^=byte;for(let k=0;k<8;k++)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;}
function chunk(type,data){const body=Buffer.concat([Buffer.from(type),data]),size=Buffer.alloc(4),check=Buffer.alloc(4);size.writeUInt32BE(data.length);check.writeUInt32BE(crc(body));return Buffer.concat([size,body,check]);}
const header=Buffer.alloc(13);header.writeUInt32BE(256);header.writeUInt32BE(160,4);header[8]=8;header[9]=2;
const pixels=Buffer.alloc(160*(256*3+1));for(let y=0;y<160;y++)for(let x=0;x<256;x++){const p=y*(256*3+1)+1+x*3;pixels[p]=40+Math.round(x/3);pixels[p+1]=90+Math.round(y/2);pixels[p+2]=100+Math.round(x/4);}
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
const threads=new Map(),running=new Map();let next=0;
function finish(threadId,id,status='completed',items=[]){const job=running.get(id);if(job)for(const t of job.timers)clearTimeout(t);running.delete(id);send({method:'turn/completed',params:{threadId,turn:{id,status,items}}});}
function trace(method,params){if(process.env.CODEX_FAKE_TRACE)fs.appendFileSync(process.env.CODEX_FAKE_TRACE,JSON.stringify({method,model:params?.model,effort:params?.effort,config:method==='thread/start'?params.config:undefined,input:method==='turn/start'?params.input:undefined})+'\n');}
const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
rl.on('line',line=>{let packet;try{packet=JSON.parse(line);}catch{return;}if(!packet.method)return;const {method,params={},id}=packet;trace(method,params);const reply=result=>send({id,result});
 if(method==='initialize'){reply({userAgent:'synthetic-codex/1.0'});return;}if(method==='initialized')return;
 if(method==='account/read'){reply({account:{type:'chatgpt',email:'synthetic@example.invalid',planType:'test'},requiresOpenaiAuth:true});return;}
 if(method==='model/list'){reply({data:models,nextCursor:null});return;}
 if(method==='thread/start'){const threadId='test-thread-'+(++next);threads.set(threadId,{model:params.model,effort:params.config?.model_reasoning_effort||models.find(m=>m.model===params.model)?.defaultReasoningEffort});reply({thread:{id:threadId},model:params.model,reasoningEffort:threads.get(threadId).effort});return;}
 if(method==='turn/start'){
  const turnId='test-turn-'+(++next),threadId=params.threadId,text=params.input.filter(i=>i.type==='text').map(i=>i.text).join('\n');reply({turn:{id:turnId,status:'inProgress',items:[]}});
  const preference=text.slice(text.lastIndexOf('\n\n输出偏好：')+'\n\n输出偏好：'.length),onlyImages=preference.startsWith('本次只生成并返回图片。');
  send({method:'turn/started',params:{threadId,turn:{id:turnId,status:'inProgress'}}});const timers=[],later=(delay,fn)=>timers.push(setTimeout(fn,delay));running.set(turnId,{timers});
  const notify=(method,extra)=>send({method,params:{threadId,turnId,...extra}});
  const currentMessage=text.includes('\n\n本次用户消息：\n')?text.split('\n\n本次用户消息：\n').at(-1):text;
  if(currentMessage.includes('合成工具断连测试')){running.get(turnId).ignoreInterrupt=true;later(40,()=>notify('item/started',{item:{id:turnId+'-blocked',type:'mcpToolCall',server:'test_tools',tool:'private_lookup',arguments:{secret:'synthetic-not-for-recording'}}}));return;}
  if(!onlyImages){later(40,()=>notify('item/agentMessage/delta',{itemId:turnId+'-text',delta:'## 合成回答\n中文图文结果 '}));
  later(150,()=>notify('item/agentMessage/delta',{itemId:turnId+'-text',delta:'🧪\n**模板原文已保留**。'}));}
  if(text.includes('慢速停止测试')){later(10000,()=>finish(threadId,turnId));return;}
  const items=onlyImages?[]:[{id:turnId+'-text',type:'agentMessage',text:'## 合成回答\n中文图文结果 🧪\n**模板原文已保留**。',phase:'final_answer'}];
  if(onlyImages||preference.includes('输出文字和图片')){for(let n=0;n<2;n++){
   const imageId=turnId+'-image-'+n;let source={result:png};
   if(process.env.CODEX_FAKE_IMAGE_FILES==='1'){
    const directory=path.join(process.env.CODEX_HOME,'generated_images',threadId),file=path.join(directory,imageId+'.png');fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(file,Buffer.from(png,'base64'));source={fileId:'synthetic-file-'+imageId,...(n===0?{savedPath:file}:{})};
   }
   const image={id:imageId,type:'imageGeneration',status:'completed',...(text.includes('图片失败测试')?{fileId:'unresolved-image'}:source)};items.push(image);later(260+n*80,()=>notify('item/completed',{item:image}));
  }if(!onlyImages)items.push({id:turnId+'-end',type:'agentMessage',text:'图文顺序已保留。\n![引用图片](https://example.invalid/never-load.png)\n<script>window.bad=true</script>',phase:'final_answer'});}
  later(450,()=>notify('thread/tokenUsage/updated',{tokenUsage:{total:{totalTokens:123},last:{totalTokens:123},modelContextWindow:10000}}));later(550,()=>finish(threadId,turnId,'completed',items));return;
 }
 if(method==='turn/interrupt'){reply({});if(!running.get(params.turnId)?.ignoreInterrupt)finish(params.threadId,params.turnId,'interrupted');return;}
 send({id,error:{code:-32601,message:'synthetic unsupported method'}});
});
rl.on('close',()=>{for(const job of running.values())for(const timer of job.timers)clearTimeout(timer);});
