import express from 'express';
export function updreamProgressRouter(store,{withActivity=fn=>fn()}={}){
 const router=express.Router();
 const wrap=fn=>(req,res,next)=>Promise.resolve().then(()=>withActivity(()=>fn(req,res))).catch(next);
 router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
 router.get('/',wrap(async(req,res)=>{
  if(Object.keys(req.query).some(k=>!['scope','offset','limit'].includes(k))||Object.values(req.query).some(v=>typeof v!=='string'))throw {code:'invalid_input'};
  res.json(await store.list({scope:req.query.scope??'all',offset:req.query.offset===undefined?0:Number(req.query.offset),limit:req.query.limit===undefined?50:Number(req.query.limit)}));
 }));
 router.get('/tasks/:id',wrap(async(req,res)=>res.json(await store.detail(req.params.id))));
 router.post('/read',express.json({limit:'24kb'}),wrap(async(req,res)=>res.json(await store.markRead(req.body))));
 router.use((error,_req,res,_next)=>{
  const code=['invalid_input','not_found','preferences_busy','preferences_unavailable','queue_unavailable'].includes(error.code)?error.code:'unavailable';
  const status=code==='invalid_input'?400:code==='not_found'?404:code==='preferences_busy'?409:503;
  res.status(status).json({code:'UPDREAM_PROGRESS_'+code.toUpperCase(),message:'本机进度暂不可用或请求无效，原任务未改动',error:'本机进度暂不可用或请求无效，原任务未改动'});
 });
 return router;
}
