import express from 'express';
import {definition,fault} from './model.mjs';
export function promptRouter(store,wrap=fn=>(req,res,next)=>Promise.resolve().then(()=>fn(req,res)).catch(next)){
 const router=express.Router();router.use(express.json({limit:'20mb'}));
 router.get('/',wrap((req,res)=>res.json(store.list({deleted:req.query.deleted==='1',q:req.query.q??''}))));
 router.get('/examples',wrap((_req,res)=>res.json(store.examples())));
 router.get('/backup',wrap((_req,res)=>res.json(store.backup())));
 router.post('/backup/preview',wrap((req,res)=>res.json(store.previewRestore(req.body))));
 router.post('/backup/restore',wrap(async(req,res)=>res.json(await store.restore(req.body))));
 router.post('/',wrap((req,res)=>res.status(201).json(store.create(req.body))));
 router.post('/import',wrap((req,res)=>{if(req.body?.format!=='shiguang-prompt-template'||req.body.schemaVersion!==1)throw fault('请选择提示词模板 JSON');res.status(201).json(store.create(definition(req.body.template)));}));
 router.put('/order',wrap((req,res)=>res.json(store.reorder(req.body))));
 router.get('/:id',wrap((req,res)=>res.json(store.get(req.params.id))));
 router.put('/:id',wrap((req,res)=>res.json(store.save(req.params.id,req.body.definition,req.body.expected_revision))));
 router.delete('/:id',wrap((req,res)=>res.json(store.setDeleted(req.params.id,true,req.body.expected_revision))));
 router.post('/:id/restore',wrap((req,res)=>res.json(store.setDeleted(req.params.id,false,req.body.expected_revision))));
 router.get('/:id/versions',wrap((req,res)=>res.json(store.versions(req.params.id))));
 router.post('/:id/rollback',wrap((req,res)=>res.json(store.rollback(req.params.id,req.body.version,req.body.expected_revision))));
 router.put('/:id/draft',wrap((req,res)=>res.json(store.saveDraft(req.params.id,req.body))));
 router.get('/:id/records',wrap((req,res)=>res.json(store.records(req.params.id,req.query.page))));
 router.post('/:id/records',wrap((req,res)=>res.status(201).json(store.generate(req.params.id,req.body))));
 router.use((_req,res)=>res.status(404).json({error:'提示词接口不存在'}));
 router.use((error,_req,res,next)=>{if(res.headersSent)return next(error);res.status(error.status??500).json({error:error.status?error.message:'提示词数据操作失败，数据未被覆盖',code:error.status===409?'PROMPT_CONFLICT':undefined});});
 return router;
}
