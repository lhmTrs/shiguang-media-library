import express from 'express';
export function fileIntakeRouter(store,native,{withActivity=fn=>fn()}={}) {
  const router=express.Router();router.use(express.json({limit:'256kb'}));
  router.use((_req,_res,next)=>next(store.initializationError));
  const route=(method,url,fn)=>router[method](url,(req,res,next)=>
    Promise.resolve().then(()=>fn(req,res)).catch(next));
  route('get','/status',async(_req,res)=>res.json({...await native.status(),...store.status()}));
  route('post','/install',async(_req,res)=>res.json(await withActivity(()=>native.install())));
  route('get','/handoffs/:id',async(req,res)=>res.json(await store.handoff(req.params.id)));
  route('get','/projects/:id/folders',async(req,res)=>res.json(await store.folders(req.params.id)));
  route('post','/handoffs/:id/confirm',async(req,res)=>res.json(await withActivity(()=>store.confirm(req.params.id,req.body))));
  route('get','/batches',(_req,res)=>res.json(store.list()));
  route('get','/batches/:id',(req,res)=>res.json(store.dto(store.batch(req.params.id))));
  route('post','/batches/:id/acknowledge',async(req,res)=>res.json(await withActivity(()=>store.acknowledge(req.params.id,req.body))));
  route('post','/batches/:id/reconcile',async(req,res)=>res.json(await withActivity(()=>store.reconcile(req.params.id))));
  route('post','/batches/:id/items/:item/resolve',async(req,res)=>res.json(await store.resolve(req.params.id,req.params.item,req.body)));
  route('post','/batches/:id/items/:item/retry',async(req,res)=>res.json(await withActivity(()=>store.retry(req.params.id,req.params.item))));
  router.use((e,_req,res,_next)=>res.status(e.status||500).json({code:e.code||'INTAKE_FAILED',
    error:e.status?e.message:'文件任务未完成，原文件和回执保留，请核对后继续'}));
  return router;
}
