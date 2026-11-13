import express from 'express';
import {ProjectScripts} from '../project-scripts/store.mjs';
import {fault} from './model.mjs';
import {streamImage} from './image-import.mjs';
export function projectAssetRouter(store, asyncRoute, {rememberTarget=async()=>{},desktop,headBox}={}) {
  const router = express.Router(),scripts=new ProjectScripts(store).init();
  router.post('/assets/:id/voice',express.json({limit:'15mb'}),asyncRoute(async(req,res)=>{
    const id=req.params.id;
    const guard=()=>{const a=store.get(id);store.project(a.project_id);store.expected(a,req.body.expected_revision);if(a.archived_at||a.kind!=='character')throw Object.assign(Error('请先选择未归档人物'),{status:409});store.generationLocks?.assertWritable(a.project_id);if(store.lib.migrating)throw Object.assign(Error('数据库正在迁移'),{status:423});};
    guard();res.json({clip:await store.voices.upload(store.get(id),req.body,guard)});
  }));
  router.put('/image-imports/:id/content',asyncRoute(async(req,res)=>{if(!req.is('application/octet-stream'))return res.status(415).json({error:'请发送所选图片原文件'});res.json(await store.imageImports.upload(req.params.id,req));}));
  router.use(express.json({ limit: '8mb' }));
  const route = (method, url, fn) => router[method](url, asyncRoute(async (req, res) => res.json(await fn(req))));
  route('post','/image-imports',req=>store.imageImports.start(req.body));
  route('get','/image-imports/:id',req=>store.imageImports.dto(store.imageImports.get(req.params.id)));
  route('post','/image-imports/:id/cancel',req=>store.imageImports.cancel(req.params.id));
  route('post','/image-imports/:id/resolve',req=>store.imageImports.resolve(req.params.id,req.body));
  router.get('/image-imports/:id/candidates/:candidateId/preview',asyncRoute((req,res)=>store.imageImports.preview(req.params.id,req.params.candidateId,res)));
  router.get('/media/:id/preview',asyncRoute(async(req,res)=>{const h=await store.inspect(req.params.id);if(h.state!=='available')return res.status(409).json({error:h.label});const a=store.lib.asset(req.params.id);await streamImage(await store.lib.checked(a.path,a.root_id),h.sha256,res);}));
  const local=req=>{if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket?.remoteAddress))throw fault('桌面操作仅限本机连接',403,{code:'DESKTOP_LOCAL_ONLY'});};
  if(desktop){
    const base='/projects/:id';
    const action=(method,url,fn)=>router[method](base+url,asyncRoute(async(req,res)=>{
      local(req);res.set('Cache-Control','no-store');
      const result=await fn(req);
      res.status(['checking','dispatching'].includes(result.status)?202:200).json(result);
    }));
    action('get','/desktop-capabilities',req=>desktop.capabilities(req.params.id));
    action('post','/images/clipboard',req=>desktop.clipboard(req.params.id,req.body));
    action('post','/images/reveal/preview',req=>desktop.revealPreview(req.params.id,req.body));
    action('post','/images/reveal',req=>desktop.reveal(req.params.id,req.body));
    action('get','/desktop-actions/:requestId',req=>desktop.status(req.params.id,req.params.requestId));
  }
  if(headBox)router.get('/bindings/:id/head-box',asyncRoute(async(req,res)=>{
    local(req);res.set('Cache-Control','no-store');
    res.json(await headBox.get(req.params.id,req.query.bindingRevision));
  }));
  route('get','/projects/:id/script',req=>scripts.get(req.params.id));
  route('put','/projects/:id/script',req=>scripts.put(req.params.id,req.body));
  const attributes = store.attributes;
  const configPath = '/projects/:id/attribute-config';
  const scorePath = '/assets/:id/attributes';
  route('get', configPath, req => attributes.getConfig(req.params.id));
  route('put', configPath, req => attributes.putConfig(req.params.id, req.body));
  route('post', configPath + '/removal-preview', req => attributes.removalPreview(req.params.id, req.body));
  route('post', configPath + '/initialize', req => attributes.putConfig(req.params.id, req.body, 'agent'));
  route('get', scorePath, req => attributes.getScores(req.params.id));
  route('patch', scorePath, req => attributes.patchScores(req.params.id, req.body));
  route('get', '/projects/:id/attributes', req => attributes.compare(req.params.id, req.query.asset_ids));
  route('post', '/projects/:id/attribute-scores', req => attributes.scoreBatch(req.params.id, req.body));
  const scoped = '/scopes/:scopeType/:scopeId';
  route('get', scoped + '/assets', req => store.scoped.list(req.params.scopeType, req.params.scopeId, req.query));
  route('get', scoped + '/overrides', req => store.scoped.seasonOverrides(req.params.scopeType, req.params.scopeId, req.query));
  route('get', scoped + '/assets/:assetId', req => store.scoped.detail(req.params.scopeType, req.params.scopeId, req.params.assetId));
  const scopeWrite = (method, suffix, action) =>
    route(method, scoped + suffix, req => action(req.params.scopeType, req.params.scopeId, req));
  const writes = store.scopedWrites;
  scopeWrite('post', '/names/check', (type, id, req) => writes.checkNames(type, id, req.body));
  scopeWrite('post', '/assets', (type, id, req) => writes.create(type, id, req.body));
  scopeWrite('put', '/assets/:assetId', (type, id, req) => writes.save(type, id, req.params.assetId, req.body));
  scopeWrite('patch', '/assets/:assetId/overrides', (type, id, req) => writes.setOverride(type, id, req.params.assetId, req.body));
  scopeWrite('get', '/attribute-config', (type, id, req) => store.scoped.attributeConfig(type, id, req.query.asset_id));
  scopeWrite('get', '/assets/:assetId/attributes', (type, id, req) => store.scoped.attributeScores(type, id, req.params.assetId));
  scopeWrite('patch', '/assets/:assetId/attributes', (type, id, req) => writes.patchScores(type, id, req.params.assetId, req.body));
  route('get', '/scoped-requests/:requestId', req => writes.request(req.params.requestId));
  route('get', '/scopes', () => store.scopes());
  route('get', '/assets', req => store.list(req.query));
  route('post', '/assets', req => store.create(req.body));
  route('get', '/assets/:id', req => store.get(req.params.id));
  router.get('/assets/:id/voice/:voiceId',asyncRoute(async(req,res)=>{const result=await store.voices.preview(store.get(req.params.id),req.params.voiceId);res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'"});res.type(result.mime).send(result.bytes);}));
  route('put', '/assets/:id', async req => {
    const previous=store.get(req.params.id),saved=await store.save(req.params.id, req.body.asset, req.body.expected_revision);
    const oldImages=new Set(previous.images.map(i=>i.id));
    // A selected project in the page remains explicit. Only a saved new image
    // binding updates the next Finder intake's optional project suggestion.
    if(saved.project_id&&saved.images.some(i=>i.archived_at===null&&!oldImages.has(i.id))){
      try{if(store.project(saved.project_id).project_kind==='normal')await rememberTarget({kind:'photo',scope:'project',projectId:saved.project_id});}catch{/* Preferences cannot undo a saved asset. */}
    }
    return saved;
  });
  route('post', '/assets/:id/archive', req => store.archive(req.params.id, req.body.archived === true, req.body.expected_revision));
  route('get', '/assets/:id/health', req => store.health(req.params.id));
  route('get', '/assets/:id/shots', req => store.associatedShots(req.params.id));
  route('get', '/assets/:id/versions', req => store.versions(req.params.id));
  route('get', '/assets/:id/versions/:version', req => store.version(req.params.id, req.params.version));
  route('get', '/assets/:id/copy-preview', req => store.copyPreview(req.params.id, req.query.project_id));
  route('post', '/assets/:id/copy', req => store.copy(req.params.id, req.body));
  route('get', '/copies/:id', req => store.copyStatus(req.params.id));
  route('get', '/media/:id/inspect', req => store.inspect(req.params.id));
  route('get', '/media/:id/usage', req => store.usage(req.params.id));
  router.get('/bindings/:id/preview', asyncRoute(async (req, res) => {
    const b = store.db.prepare('SELECT * FROM creative_image_bindings WHERE id=?').get(req.params.id);
    if (!b) return res.status(404).end();
    const health = await store.inspect(b.media_asset_id, b.expected_sha256);
    if (health.state !== 'available') return res.status(409).json({ error: health.label });
    const media = store.lib.asset(b.media_asset_id), file = await store.lib.checked(media.path, media.root_id);
    await streamImage(file,b.expected_sha256,res);
  }));
  route('get', '/backup', () => store.backup());
  route('post', '/restore', req => store.restore(req.body));
  router.use((_req, res) => res.status(404).json({ error: '资产库接口不存在' }));
  router.use((error, _req, res, next) => { if (res.headersSent) return next(error); res.status(error.status ?? 500).json({ error: error.status ? error.message : '资产库操作失败，未确认保存；请保留编辑并重试', ...(error.status&&error.code ? {code:error.code} : {}), ...(Number.isSafeInteger(error.current_revision) ? { current_revision: error.current_revision } : {}), ...(error.status === 409 && error.current ? { current: error.current } : {}), ...(error.status && error.details ? { details: error.details } : {}) }); });
  return router;
}
