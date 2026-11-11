import express from 'express';
import {streamImage} from '../project-assets/image-import.mjs';
import {uuid,error,revalidateSelection} from './files.mjs';
export function fileIntakeRouter(store,native,{withActivity=fn=>fn(),sendMedia}={}) {
  const router=express.Router();router.use(express.json({limit:'256kb'}));
  router.use((_req,_res,next)=>next(store.initializationError));
  const route=(method,url,fn)=>router[method](url,(req,res,next)=>
    Promise.resolve().then(()=>fn(req,res)).catch(next));
  router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
  route('get','/preferences',(_req,res)=>res.json(store.intakePreferences()));
  route('get','/routing-options',async(_req,res)=>res.json(await withActivity(()=>store.routingOptions())));
  route('get','/theme',(_req,res)=>res.json({themeId:store.preferences?.themeId??null}));
  route('put','/theme',async(req,res)=>res.json(await withActivity(()=>{
    store.assertOpen();
    if(!store.preferences)throw error('INTAKE_STORAGE_UNAVAILABLE','本机主题偏好暂不可写',503);
    return store.preferences.setTheme(req.body??{});
  })));
  route('get','/categories/:kind',async(req,res)=>res.json(await store.generic.choices(req.params.kind)));
  route('post','/categories/:kind',async(req,res)=>res.json(await withActivity(()=>store.generic.createFolder(req.params.kind,req.body))));
  route('get','/image-proposal',async(req,res)=>res.json(await store.generic.imageProposal(req.query.projectId,req.query.name,req.query.lookName)));
  route('get','/status',async(_req,res)=>res.json({...await native.status(),...store.status()}));
  route('post','/install',async(_req,res)=>res.json(await withActivity(()=>native.install())));
  route('get','/handoffs/:id',async(req,res)=>res.json(await store.handoff(req.params.id)));
  route('post','/handoffs/:id/name-preview',async(req,res)=>res.json(await withActivity(()=>store.namePreview(req.params.id,req.body))));
  route('get','/handoffs/:id/files/:fileId/preview',async(req,res)=>{
    const media=store.catalog.media;
    await withActivity(()=>media.track(async()=>{
    media.responses.add(res);
    try{
    if(!uuid(req.params.fileId))throw error('INTAKE_NOT_FOUND','图片选择不存在',404);const h=await store.receipts.read('handoffs',req.params.id);const f=h.files.find(v=>v.id===req.params.fileId);
    if(!f||f.mediaKind!=='photo'||h.preparation!=='ready'||!/^[a-f0-9]{64}$/.test(f.selectionSha256||''))throw error('INTAKE_SELECTION_CHECKING','图片尚未完成核验',422);
    await revalidateSelection(f);
    await streamImage(f.path,f.selectionSha256,res,{media,verifySource:()=>revalidateSelection(f)});
    }finally{media.responses.delete(res);}
    }));
  });
  route('get','/projects/:id/folders',async(req,res)=>res.json(await store.folders(req.params.id)));
  route('post','/handoffs/:id/confirm',async(req,res)=>res.json(await withActivity(()=>store.confirm(req.params.id,req.body))));
    route('get','/media-imports/:requestId/candidates/:candidateId/media',async(req,res)=>{
    const opened=await store.generic.openCandidate(req.params.requestId,req.params.candidateId);let done=false;
    const release=()=>{if(done)return;done=true;store.catalog.media.responses.delete(res);void store.catalog.media.release(opened.handle).catch(()=>{});};
    store.catalog.media.responses.add(res);res.once('close',release);res.once('finish',release);
    try{await sendMedia(req,res,opened.path,opened.handle);}catch(e){release();throw e;}
  });
  route('get','/batches',(_req,res)=>res.json(store.list()));
  route('get','/batches/:id',(req,res)=>res.json(store.dto(store.batch(req.params.id))));
  route('post','/batches/:id/acknowledge',async(req,res)=>res.json(await withActivity(()=>store.acknowledge(req.params.id,req.body))));
  route('post','/batches/:id/reconcile',async(req,res)=>res.json(await withActivity(()=>store.reconcile(req.params.id))));
  route('post','/batches/:id/items/:item/resolve',async(req,res)=>res.json(await store.resolve(req.params.id,req.params.item,req.body)));
  route('post','/batches/:id/items/:item/retry',async(req,res)=>res.json(await withActivity(()=>store.retry(req.params.id,req.params.item))));
  router.use((e,_req,res,_next)=>{if(res.destroyed||res.writableEnded)return;if(res.headersSent){res.destroy();return;}res.status(e.status||500).json({code:e.code||'INTAKE_FAILED',
    error:e.status?e.message:'文件任务未完成，原文件和回执保留，请核对后继续',...(e.accepted===false?{accepted:false,requestId:e.requestId}:{})});});
  return router;
}
