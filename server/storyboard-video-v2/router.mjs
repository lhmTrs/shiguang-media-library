import express from 'express';
const businessErrors=new Set(['VIDEO_V2_INVALID_INPUT','VIDEO_V2_NOT_FOUND','SHOT_NOT_FOUND','VIDEO_BINDING_CONFLICT','VIDEO_SELECTION_CONFLICT','STORYBOARD_CONFLICT','ASSET_CONTEXT_CHANGED','VIDEO_ORIGIN_CONFLICT','VIDEO_REVIEW_CONFLICT','VIDEO_TARGET_SCOPE_CHANGED','REQUEST_ID_CONFLICT','VIDEO_REPLACEMENT_CONFIRMATION_REQUIRED','VIDEO_UNBIND_SCOPE_REQUIRED','VERSION_PRUNED','VIDEO_V2_MIGRATION_REQUIRED','VIDEO_V2_UNSETTLED','UNBIND_CONFIRMATION_REQUIRED']);
export function v2ErrorEnvelope(_req,res,next){
 res.setHeader('Cache-Control','no-store');const json=res.json.bind(res);res.json=body=>{if(res.statusCode<400)return json(body);const known=businessErrors.has(body?.code),message=res.statusCode>=500&&!known?'视频绑定状态无法核验，请保留当前操作并重读':body?.message??body?.error??'本机请求未通过校验';return json({code:body?.code??(res.statusCode===401?'LOCAL_SESSION_REQUIRED':res.statusCode===403?'LOCAL_REQUEST_REJECTED':'VIDEO_V2_UNSETTLED'),message,error:message,...(body?.details&&{details:body.details})});};next();
}
export function videoBindingV2Router(store){
 const router=express.Router();router.use(express.json({limit:'2mb'}));router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
 const route=(method,path,fn)=>router[method](path,(req,res,next)=>store.videos.media.track(async()=>res.json(await fn(req))).catch(next));
 route('get','/projects/:projectId/state',r=>store.state(r.params.projectId));
 route('get','/projects/:projectId/shots/:shotId/videos',r=>store.shotVideos(r.params.projectId,r.params.shotId,{offset:r.query.offset===undefined?0:Number(r.query.offset),limit:r.query.limit===undefined?20:Number(r.query.limit)}));
 route('get','/source-projects/:sourceProjectId/videos/:videoId/binding',r=>store.sourceBinding(r.params.sourceProjectId,r.params.videoId));
 route('post','/source-projects/:sourceProjectId/videos/:videoId/binding/preview',r=>store.previewBinding(r.params.sourceProjectId,r.params.videoId,r.body));
 route('put','/source-projects/:sourceProjectId/videos/:videoId/binding',r=>store.bind(r.params.sourceProjectId,r.params.videoId,r.body));
 route('post','/projects/:projectId/selections/preview',r=>store.previewSelection(r.params.projectId,r.body));
 route('post','/projects/:projectId/selections',r=>store.select(r.params.projectId,r.body));
 route('post','/projects/:projectId/provenance',r=>store.reserve(r.params.projectId,r.body));
 route('get','/provenance/:provenanceId',r=>store.provenance(r.params.provenanceId));
 route('post','/provenance/:provenanceId/release',r=>store.release(r.params.provenanceId,r.body));
 route('post','/source-projects/:sourceProjectId/videos/:videoId/record-origin',r=>store.recordOrigin(r.params.sourceProjectId,r.params.videoId,r.body));
 // Product entry restriction only; existing local-session gates do not prove a human identity.
 route('post','/ui/source-projects/:sourceProjectId/videos/:videoId/review',r=>store.review(r.params.sourceProjectId,r.params.videoId,r.body));
 route('get','/requests/:requestId',r=>store.request(r.params.requestId));
 router.use((_req,res)=>res.status(404).json({code:'VIDEO_V2_NOT_FOUND',message:'视频绑定v2接口不存在',error:'视频绑定v2接口不存在'}));
 router.use((e,_req,res,next)=>{if(res.headersSent)return next(e);const status=e.status??500,message=businessErrors.has(e.code)?e.message:status===400?'请求JSON格式或字段无效':'视频绑定状态无法核验，请保留当前操作并重读';res.status(status).json({code:businessErrors.has(e.code)?e.code:status===400?'VIDEO_V2_INVALID_INPUT':status===404?'VIDEO_V2_NOT_FOUND':status===409?'VIDEO_BINDING_CONFLICT':'VIDEO_V2_UNSETTLED',message,error:message,...(businessErrors.has(e.code)&&e.details&&{details:e.details})});});
 return router;
}
