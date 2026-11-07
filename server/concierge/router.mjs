import express from 'express';
import {exact,fault,uuid} from './store.mjs';

// Internal business calls traverse the same HTTP session, token, Host and module guards
// as a human UI action. Neither model arguments nor documents choose this origin.
function businessInvoker(req){
  const port=req.socket.localPort;if(!Number.isInteger(port)||port<1)throw fault('无法确认本机业务服务',503);
  const origin='http://127.0.0.1:'+port,cookie=req.headers.cookie,token=req.headers['x-local-token'];
  return async(method,url,body)=>{
    if(!['GET','POST','PUT','PATCH','DELETE'].includes(method)||typeof url!=='string'||!url.startsWith('/api/')||/[\r\n\\#]/.test(url)||url.startsWith('/api/concierge'))throw fault('业务接口调用地址无效',403);
    const target=new URL(url,origin);if(target.origin!==origin)throw fault('业务调用超出本机范围',403);
    const response=await fetch(target,{method,headers:{cookie:cookie??'',origin,'x-local-token':token??'','content-type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000),redirect:'error'});
    const chunks=[];let size=0;for await(const chunk of response.body??[]){size+=chunk.length;if(size>1024*1024)throw fault('业务结果过大，请缩小查询范围',413);chunks.push(chunk);}const raw=Buffer.concat(chunks).toString('utf8');
    let value;try{value=JSON.parse(raw);}catch{throw fault('业务接口未返回有效结果',502);}
    if(!response.ok)throw fault(value.error||value.message||'业务操作未完成',response.status,value.code||'CONCIERGE_BUSINESS_FAILED');return value;
  };
}
export function conciergeRouter(service,{sendMedia,withActivity=fn=>fn()}={}){
  const router=express.Router();router.use(express.json({limit:'2mb'}));
  const route=(method,url,fn)=>router[method](url,(req,res,next)=>Promise.resolve().then(()=>withActivity(()=>service.store.capture(()=>fn(req,res)))).catch(next));
  const scope=req=>{const s=req.query.scope??req.body?.scope;service.store.scope(s);return s;};
  route('get','/status',(_req,res)=>res.json(service.status()));
  route('post','/connect',async(_req,res)=>res.json(await service.connect()));
  route('get','/scope',(req,res)=>res.json(service.scopeState(scope(req))));
  route('post','/scope',async(req,res)=>{exact(req.body,['scope']);res.json(await service.ensureScope(scope(req)));});
  route('post','/scope/recover',async(req,res)=>{exact(req.body,['scope']);res.json(await service.recover(scope(req)));});
  route('get','/history',async(req,res)=>res.json(await service.history(scope(req),{cursor:req.query.cursor,limit:req.query.limit})));
  route('get','/tasks',(req,res)=>res.json(service.listTasks(req.query.scope??'all')));
  route('get','/tasks/:id',(req,res)=>res.json({task:service.task(req.params.id,scope(req))}));
  route('post','/turns',async(req,res)=>{
    try{res.status(202).json(await service.start(req.body,businessInvoker(req)));}
    catch(e){if(uuid(req.body?.id)){try{if(!service.store.rawTask(req.body.id)){e.conciergeNotAccepted=true;e.conciergeRequestId=req.body.id;}}catch{}}throw e;}
  });
  route('post','/tasks/:id/stop',async(req,res)=>{exact(req.body,['scope']);res.json(await service.stop(req.params.id,scope(req)));});
  route('get','/rules',(req,res)=>res.json(service.rules(scope(req))));
  route('put','/rules',(req,res)=>{service.store.saveRule(req.body);res.json(service.rules(scope(req)));});
  route('get','/capabilities',(req,res)=>res.json(service.capabilities.catalog(scope(req))));
  route('get','/docs',(req,res)=>res.json(service.capabilities.docs(scope(req),{query:req.query.query,operationId:req.query.operationId})));
  route('get','/attachments',async(req,res)=>res.json({attachments:await service.attachments.list(scope(req))}));
  route('post','/attachments',async(req,res)=>{exact(req.body,['scope','id','name','size','mime']);res.status(201).json({attachment:await service.attachments.prepare(scope(req),req.body)});});
  route('put','/attachments/:id/content',async(req,res)=>{if(service.closing)throw fault('应用正在关闭，附件未提交',503);res.json({attachment:await service.attachments.upload(scope(req),req.params.id,req)});});
  route('get','/attachments/:id',async(req,res)=>res.json({attachment:await service.attachments.get(scope(req),req.params.id)}));
  route('get','/attachments/:id/preview',async(req,res)=>{const opened=await service.attachments.openPreview(scope(req),req.params.id);res.setHeader('Content-Type',opened.mime);res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'");try{if(sendMedia)await sendMedia(req,res,opened.path,opened.handle);else res.send(await opened.handle.readFile());}finally{await opened.handle.close();}});
  route('delete','/attachments/:id',async(req,res)=>{exact(req.body,['scope']);if(service.store.active(scope(req)))throw fault('本对话仍有任务，不能移除附件',409);await service.attachments.remove(scope(req),req.params.id);res.json({removed:true});});
  router.use((_req,res)=>res.status(404).json({error:'管家接口不存在',code:'CONCIERGE_ROUTE_NOT_FOUND'}));
  router.use((e,_req,res,next)=>{if(res.headersSent)return next(e);res.status(e.status??500).json({error:e.status||e.code?.startsWith('CODEX_')?e.message:'管家操作未完成，请保留输入并核对原任务',code:e.code??'CONCIERGE_OPERATION_FAILED',...(e.conciergeNotAccepted?{accepted:false,requestId:e.conciergeRequestId}:{})});});
  return router;
}
