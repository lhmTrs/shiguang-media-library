import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fault} from '../prompt-templates/model.mjs';

export function codexRouter(store,service,media,backup,wrap=fn=>(req,res,next)=>Promise.resolve().then(()=>fn(req,res)).catch(next)){
  const router=express.Router(),small=express.json({limit:'1mb'}),large=express.json({limit:'100mb'});let viewers=0;
  router.get('/status',wrap((_req,res)=>res.json(service.status())));
  router.get('/tasks',wrap((req,res)=>{res.setHeader('Cache-Control','no-store');res.json(service.taskOverview(req.query));}));
  router.get('/tasks/:taskId/stop-impact',wrap((req,res)=>{res.setHeader('Cache-Control','no-store');res.json(service.stopImpact(req.params.taskId));}));
  router.post('/tasks/:taskId/stop',small,wrap(async(req,res)=>res.json(await service.stopTask(req.params.taskId,req.body))));
  router.post('/connect',small,wrap(async(_req,res)=>res.json(await service.connect())));
  router.post('/disconnect',small,wrap(async(_req,res)=>{await service.disconnect();res.json(service.status());}));
  router.post('/default-library',small,wrap(async(_req,res)=>{
    if(!service.pictures)throw fault('当前服务未配置默认图片目录',503);
    if(service.closing)throw fault('服务正在关闭，请稍后再试',423);
    res.json(await service.withActivity(()=>service.pictures.initialize()));
  }));
  router.get('/backup',wrap(async(_req,res)=>res.json(await backup.backup())));
  router.post('/backup/preview',large,wrap((req,res)=>res.json(backup.preview(req.body))));
  router.post('/backup/restore',large,wrap(async(req,res)=>res.json(await backup.restore(req.body))));
  router.get('/conversations',wrap((req,res)=>res.json(store.list({templateId:req.query.template_id,deleted:req.query.deleted==='1'}))));
  router.post('/conversations',small,wrap((req,res)=>res.status(201).json(store.create(req.body))));
  router.get('/conversations/:id',wrap((req,res)=>res.json(store.get(req.params.id))));
  router.delete('/conversations/:id',small,wrap((req,res)=>res.json(store.setDeleted(req.params.id,true,req.body.expected_revision))));
  router.post('/conversations/:id/restore',small,wrap((req,res)=>res.json(store.setDeleted(req.params.id,false,req.body.expected_revision))));
  router.post('/conversations/:id/turns',small,wrap(async(req,res)=>res.status(202).json(await service.start(req.params.id,req.body))));
  router.post('/conversations/:id/turns/:turnId/stop',small,wrap(async(req,res)=>res.json(await service.stop(req.params.id,req.params.turnId,req.body))));
  router.get('/conversations/:id/events',(req,res,next)=>{
    try{
      store.head(req.params.id);if(viewers>=32)throw fault('打开的生成页面过多，请关闭其他页面后重试',429);viewers++;
      res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache, no-store');res.setHeader('X-Accel-Buffering','no');res.flushHeaders();
      const send=()=>{if(service.closing){res.end();return;}if(res.writableLength>4*1024*1024){res.end();return;}res.write('event: snapshot\ndata: '+JSON.stringify(store.get(req.params.id))+'\n\n');};
      const unsubscribe=service.subscribe(id=>{if(!id||id===req.params.id){try{send();}catch{res.end();}}});
      const keepalive=setInterval(()=>res.write(': keepalive\n\n'),20000);
      res.on('close',()=>{viewers--;clearInterval(keepalive);unsubscribe();});send();
    }catch(e){next(e);}
  });
  router.get('/images/:id',wrap(async(req,res)=>{
    const row=store.attachment(req.params.id),bytes=await media.read(row);
    res.setHeader('Content-Type',row.mime);res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");
    if(req.query.download==='1')res.setHeader('Content-Disposition',`attachment; filename="${row.file_name}"`);
    res.send(bytes);
  }));
  router.get('/library-destinations',wrap((_req,res)=>res.json(store.lib.roots().filter(r=>['photo','mixed'].includes(r.kind)&&r.online!==0).map(r=>({id:r.id,name:r.name})))));
  router.post('/images/:id/add-to-library',small,wrap(async(req,res)=>{
    if(process.env.MEDIA_READONLY_FILES==='1')throw fault('当前素材目录为只读，请下载图片后自行导入',403);
    if(req.body.confirm!==true)throw fault('请确认将新图片复制到所选素材目录');
    const row=store.attachment(req.params.id),root=store.lib.roots().find(r=>r.id===req.body.root_id&&['photo','mixed'].includes(r.kind));
    if(!root)throw fault('请选择已登记的照片或混合素材目录');
    const destination=await fs.realpath(root.path);if(destination!==root.path)throw fault('目标目录位置已变化，请重新登记',409);
    const before=await fs.lstat(destination);if(!before.isDirectory()||before.isSymbolicLink())throw fault('目标目录不可用');
    const file=path.join(destination,'Codex-'+row.file_name),bytes=await media.read(row);
    const current=await fs.lstat(destination);if(current.dev!==before.dev||current.ino!==before.ino)throw fault('目标目录已变化，未写入',409);
    try{await fs.writeFile(file,bytes,{flag:'wx'});}catch(e){if(e.code==='EEXIST')throw fault('该图片已存在于目标目录，未覆盖',409);throw e;}
    const job=store.lib.scan(root.id);res.json({added:true,job,fileName:path.basename(file)});
  }));
  router.use((_req,res)=>res.status(404).json({error:'Codex 接口不存在'}));
  router.use((error,_req,res,next)=>{if(res.headersSent)return next(error);res.status(error.status??500).json({error:error.status?error.message:'Codex 数据操作失败，已保存的内容保留',code:error.code??(error.status===409?'CODEX_CONFLICT':undefined)});});
  return router;
}
