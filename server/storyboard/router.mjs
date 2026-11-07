import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectStore, StoreError } from './storage.mjs';
import { schema } from './shared/schema.mjs';
import { StoryboardDatabase } from './database.mjs';

// Mounted after the application's existing session and same-origin guards.
// No listener, child process, second session or separate workspace setting.
export function createStoryboardModule({ dataDir, lib, projectAssets }) {
  const legacy = new ProjectStore(path.join(dataDir, 'storyboards'));
  const store = lib ? new StoryboardDatabase(lib, projectAssets).init() : legacy;
  const router = express.Router(), pending = new Set();
  let closing = false;
  const admit = (_req, res, next) => closing
    ? res.status(503).json({ message: '分镜正在保存并关闭，请稍后重试' }) : next();
  const route = fn => (req, res, next) => {
    const work = Promise.resolve().then(() => fn(req, res));
    pending.add(work);
    work.catch(next).finally(() => pending.delete(work));
  };
  router.use(admit, express.json({ limit: '100mb' }), admit);
  router.get('/workspace', (_req, res) => res.json({ workspace: lib ? '当前素材管理器数据库' : store.root, integrated: true, database: !!lib, storage: lib?.db.kind === 'mysql' ? 'mysql' : 'sqlite' }));
  router.get('/example', (_req, res) => res.sendFile(fileURLToPath(new URL('./example.json', import.meta.url))));
  router.get('/schema', (_req, res) => res.json(schema));
  router.get('/initialization-schema', (_req,res) => res.sendFile(fileURLToPath(new URL('./initialization.schema.json',import.meta.url))));
  if (lib) {
    router.get('/backup', route(async (_req,res) => res.json(store.backup())));
    router.post('/restore', route(async (req,res) => res.json(await store.restore(req.body))));
    router.get('/legacy/projects', route(async (_req,res) => res.json(await legacy.list())));
    router.get('/legacy/projects/:id', route(async (req,res) => res.json(await legacy.read(req.params.id))));
    router.post('/projects/:id/preview', route(async (req,res) => res.json(store.preview(req.params.id,req.body))));
    router.post('/projects/:id/initialize', route(async (req,res) => res.json(store.initialize(req.params.id,req.body))));
    router.get('/projects/:id/requests/:request', route(async (req,res) => res.json(store.request(req.params.id,req.params.request))));
    router.get('/projects', route(async (_req,res) => res.json(store.list())));
    router.get('/projects/:id', route(async (req,res) => res.json(store.read(req.params.id))));
    router.put('/projects/:id', route(async (req,res) => res.json(store.save(req.params.id,req.body))));
  } else {
  router.get('/projects', route(async (_req, res) => res.json(await store.list())));
  router.get('/projects/:id', route(async (req, res) => res.json(await store.read(req.params.id))));
  router.put('/projects/:id', route(async (req, res) => {
    if (req.body?.project?.project_id !== req.params.id) throw new StoreError('项目 ID 不匹配');
    res.json(await store.save(req.body.project, req.body.expected_hash ?? null));
  }));
  }
  router.get('/projects/:id/media', route(async (req, res) => {
    const p = lib ? store.read(req.params.id).project : null;
    if (lib && (!p.assets.some(a=>a.path===req.query.path) || !p.legacy_media_project_id)) throw new StoreError('旧版参考素材不存在，请在项目资产库重新绑定',404);
    const file = await legacy.media(lib ? p.legacy_media_project_id : req.params.id, req.query.path);
    res.set('Content-Security-Policy', "sandbox; default-src 'none'");
    await new Promise((resolve, reject) => res.sendFile(file, error => error ? reject(error) : resolve()));
  }));
  router.use((_req, res) => res.status(404).json({ message: '分镜接口不存在' }));
  router.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status ?? (error.code === 'ENOENT' ? 404 : 500);
    res.status(status).json({ message: error.message, ...error.details, errors: error.errors, current_revision: error.current_revision });
  });
  return {
    router, store,
    beginClose() { closing = true; },
    async close() {
      closing = true;
      let timer;
      try {
        await Promise.race([
          Promise.allSettled([...pending, ...legacy.locks.values()]),
          new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(Error('STORYBOARD_WORK_UNSETTLED'), { code: 'STORYBOARD_WORK_UNSETTLED' })), 10000); }),
        ]);
      } finally { clearTimeout(timer); }
    },
  };
}
