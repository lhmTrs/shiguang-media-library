// /api/notices：沿用全站的本机地址、会话 Cookie 与写令牌（x-local-token）校验（在 index.mjs 的 /api 闸门之后挂载）。
// 页面与 AI 用同一种本机会话，服务端无法从技术上区分；做决定的接口要求浏览器自带的 Sec-Fetch-Site: same-origin，
// 和项目音乐「仅页面」的操作一样。这一层可以被刻意伪造，所以只是防误用，不是安全边界。
import express from 'express';
import {NOTICES_AGENT_SCHEMA} from './agent-schema.mjs';

const fromPage = req => req.get('sec-fetch-site') === 'same-origin';
const pageOnly = req => {
  if (!fromPage(req)) throw Object.assign(Error('只有用户能在网页上做决定。AI 和后台程序只能放卡片、读决定、回报执行结果，不能替用户点「重做」「不重做」「稍后」「已读」'), {status: 403, code: 'PAGE_ONLY'});
};

export function noticesRouter(store, {withActivity = fn => fn()} = {}) {
  const router = express.Router();
  router.use(express.json({limit: '64kb'}));
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const route = (method, url, fn) => router[method](url, (req, res, next) => {
    Promise.resolve().then(() => withActivity(() => fn(req, res))).catch(next);
  });

  route('get', '/schema', (_req, res) => res.json(NOTICES_AGENT_SCHEMA));
  route('get', '/summary', (_req, res) => { store.sync(); res.json({summary: store.summary()}); });
  route('get', '/', (req, res) => res.json(store.list(req.query)));
  route('post', '/', (req, res) => {
    const out = store.post(req.body ?? {});
    res.status(out.created ? 201 : 200).json(out);
  });
  route('get', '/:id', (req, res) => res.json(store.one(req.params.id)));
  route('patch', '/:id/decision', (req, res) => { pageOnly(req); res.json(store.decide(req.params.id, req.body ?? {})); });
  route('post', '/:id/result', (req, res) => res.json(store.report(req.params.id, req.body ?? {})));

  router.use((_req, res) => res.status(404).json({error: '待处理接口不存在', code: 'NOTICES_ROUTE_NOT_FOUND'}));
  router.use((e, _req, res, next) => {
    if (res.headersSent) return next(e);
    if (e.type === 'entity.too.large') return res.status(413).json({error: '请求内容过大', code: 'BODY_TOO_LARGE'});
    if (e.type === 'entity.parse.failed') return res.status(400).json({error: '请求不是有效的 JSON', code: 'INVALID_JSON'});
    if (!e.status) console.error('[notices]', e);
    res.status(e.status ?? 500).json({error: e.status ? e.message : '待处理读写失败，请稍后重试', code: e.code ?? 'NOTICES_ERROR', ...(e.details ? {details: e.details} : {})});
  });
  return router;
}
