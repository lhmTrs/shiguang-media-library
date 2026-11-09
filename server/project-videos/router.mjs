import express from 'express';
export function projectVideoRouter(store,{sendMedia,withActivity=fn=>fn()}={}){
 const router=express.Router(),route=(method,url,fn)=>router[method]('/projects/:projectId'+url,(req,res,next)=>{try{Promise.resolve(withActivity(()=>store.media.track(()=>fn(req,res)))).catch(next);}catch(e){next(e);}});
 router.use(express.json({limit:'2mb'}));router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
 route('get','',(req,res)=>store.list(req.params.projectId,{folderId:req.query.folderId||'all',checkLegacyVideos:req.query.checkLegacyVideos==='true'}).then(v=>res.json(v)));
 route('post','/folders',async(req,res)=>res.json(await store.folders.create(req.params.projectId,req.body)));
 route('post','/folders/refresh',async(req,res)=>res.json(await store.folders.refresh(req.params.projectId,req.body.folderId||'root')));
 route('post','/operations/preview',async(req,res)=>res.json(await store.fileOperations.preview(req.params.projectId,req.body)));
 route('post','/operations',async(req,res)=>res.json(await store.fileOperations.execute(req.params.projectId,req.body)));
 route('get','/operations/:requestId',(req,res)=>res.json(store.fileOperations.dto(req.params.requestId,store.fileOperations.row(req.params.projectId,req.params.requestId))));
 route('post','/operations/:requestId/recover',async(req,res)=>res.json(await store.fileOperations.recover(req.params.projectId,req.params.requestId,req.body)));
 route('post','/imports',async(req,res)=>res.json(await store.start(req.params.projectId,req.body)));
 route('put','/imports/:requestId/content',async(req,res)=>res.json(await store.upload(req.params.projectId,req.params.requestId,req)));
 route('get','/imports/:requestId',(req,res)=>res.json(store.receiptDTO(store.receipt(req.params.projectId,req.params.requestId))));
 route('post','/imports/:requestId/resolve',async(req,res)=>res.json(await store.resolve(req.params.projectId,req.params.requestId,req.body)));
 route('patch','/videos/:sourceId',async(req,res)=>res.json(await store.update(req.params.projectId,req.params.sourceId,req.body)));
 route('post','/videos/:sourceId/remove',(req,res)=>res.json(store.remove(req.params.projectId,req.params.sourceId,req.body)));
 route('post','/videos/:sourceId/relink',async(req,res)=>res.json(await store.relink(req.params.projectId,req.params.sourceId,req.body)));
 route('post','/videos/:sourceId/reveal',async(req,res)=>res.json(await store.reveal(req.params.projectId,req.params.sourceId)));
 route('get','/upgrade',async(req,res)=>res.json(await store.upgradePlan(req.params.projectId)));
 route('post','/upgrade',async(req,res)=>res.json(await store.upgrade(req.params.projectId,req.body)));
 const serve=async(req,res,candidate)=>{const opened=await(candidate?store.openCandidate(req.params.projectId,req.params.requestId,req.params.candidateId):store.open(req.params.projectId,req.params.sourceId));let done=false;const release=()=>{if(done)return;done=true;store.media.responses.delete(res);void store.media.release(opened.handle).catch(()=>{});};store.media.responses.add(res);res.once('close',release);res.once('finish',release);try{if(req.method==='HEAD'){const st=await opened.handle.stat();res.setHeader('Content-Length',st.size);res.setHeader('Accept-Ranges','bytes');res.setHeader('Content-Type',opened.path.toLowerCase().endsWith('.webm')?'video/webm':'video/mp4');res.end();}else await sendMedia(req,res,opened.path,opened.handle);}catch(e){release();throw e;}};
 route('get','/videos/:sourceId/media',(req,res)=>serve(req,res,false));route('head','/videos/:sourceId/media',(req,res)=>serve(req,res,false));route('get','/imports/:requestId/candidates/:candidateId/media',(req,res)=>serve(req,res,true));
 router.use((_req,res)=>res.status(404).json({error:'项目视频接口不存在',code:'VIDEO_ROUTE_NOT_FOUND'}));router.use((e,_req,res,next)=>{if(res.headersSent)return next(e);res.status(e.status??500).json({error:e.status?e.message:'项目视频操作未完成，请核对同一请求结果',code:e.code??'PROJECT_VIDEO_FAILED'});});return router;
}
