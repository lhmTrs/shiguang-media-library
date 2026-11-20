// /api/project-music：沿用全站的本机地址、会话 Cookie 与写令牌校验（在 index.mjs 的 /api 闸门之后挂载）。
// 页面与 AI 用同一种本机会话，服务端无法从技术上区分；这里做两层防误用：
// 1) AI 走 /agent-notes，只收 AI 字段；2) 只能由用户做的操作要求浏览器自带的 Sec-Fetch-Site: same-origin。
// 第 2 层可以被刻意伪造，所以只是防误用，不是安全边界。
import express from 'express';
import {AGENT_SCHEMA} from './agent-schema.mjs';
import {agentAuthor, fail, userAuthor} from './model.mjs';

const fromPage = req => req.get('sec-fetch-site') === 'same-origin';
const actor = req => fromPage(req) ? userAuthor() : agentAuthor(req.body?.session);
const pageOnly = req => {
  if (!fromPage(req)) fail('PAGE_ONLY', '这项只能由你在网页上操作：AI 不能改提示词确认和你的听感原文；AI 改版本状态请走 agent-notes 的 decisions，并附上用户原话', 403);
};

export function projectMusicRouter(store, {sendMedia, withActivity = fn => fn()} = {}) {
  const router = express.Router();
  router.use(express.json({limit: '256kb'}));
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const route = (method, url, fn) => router[method](url, (req, res, next) => {
    Promise.resolve().then(() => withActivity(() => store.track(() => fn(req, res)))).catch(next);
  });
  const P = '/projects/:projectId';

  route('get', '/schema', (_req, res) => res.json(AGENT_SCHEMA));
  route('get', P, (req, res) => res.json(store.list(req.params.projectId)));
  route('get', P + '/songs/:songId', (req, res) => res.json(store.song(req.params.projectId, req.params.songId)));
  route('post', P + '/songs', (req, res) => res.json(store.createSong(req.params.projectId, req.body ?? {}, actor(req))));
  route('patch', P + '/songs/:songId', (req, res) => { pageOnly(req); res.json(store.updateSong(req.params.projectId, req.params.songId, req.body ?? {})); });
  route('post', P + '/songs/:songId/rounds', (req, res) => res.json(store.createRound(req.params.projectId, req.params.songId, req.body ?? {}, actor(req))));
  route('patch', P + '/rounds/:roundId/agent-notes', (req, res) => res.json(store.agentNotes(req.params.projectId, req.params.roundId, req.body ?? {})));
  route('patch', P + '/rounds/:roundId', (req, res) => { pageOnly(req); res.json(store.updateRound(req.params.projectId, req.params.roundId, req.body ?? {})); });
  route('patch', P + '/versions/:versionId', (req, res) => { pageOnly(req); res.json(store.updateVersion(req.params.projectId, req.params.versionId, req.body ?? {})); });
  route('post', P + '/songs/:songId/comparisons', (req, res) => { pageOnly(req); res.json(store.createComparison(req.params.projectId, req.params.songId, req.body ?? {})); });

  route('post', P + '/imports', (req, res) => res.json(store.startImport(req.params.projectId, req.body ?? {}, actor(req))));
  route('put', P + '/imports/:requestId/content', async (req, res) => res.json(await store.upload(req.params.projectId, req.params.requestId, req)));
  route('get', P + '/imports/:requestId', (req, res) => res.json(store.receipt(req.params.projectId, req.params.requestId)));
  route('post', P + '/imports/:requestId/resolve', async (req, res) => res.json(await store.resolveImport(req.params.projectId, req.params.requestId, req.body ?? {})));

  route('post', P + '/songs/:songId/finalize', (req, res) => { pageOnly(req); res.json(store.finalize(req.params.projectId, req.params.songId, req.body ?? {})); });
  // PR3：定稿只做标记，不再复制进音乐库，原来的「重名选择」步骤没有了。
  route('post', P + '/songs/:songId/finalize/:requestId/resolve', () => fail('FINALIZE_FLOW_RETIRED', '定稿已改为只在项目里标记，不再有重名选择；请直接重新定稿', 410));
  route('post', P + '/songs/:songId/unfinalize', (req, res) => { pageOnly(req); res.json(store.unfinalize(req.params.projectId, req.params.songId, req.body ?? {})); });
  // AI 按你的原话改的版本状态：页面上一键改回。
  route('post', P + '/songs/:songId/decisions/:decisionId/undo', (req, res) => { pageOnly(req); res.json(store.undoDecision(req.params.projectId, req.params.songId, req.params.decisionId, req.body ?? {})); });
  // 旧位置（PR1、PR2）的歌：重试搬迁；确认后把旧副本移到废纸篓（只能由你在页面上做）。
  route('post', P + '/legacy/migrate', async (req, res) => res.json(await store.retryMigration(req.params.projectId)));
  route('post', P + '/legacy/trash', async (req, res) => { pageOnly(req); res.json(await store.trashLegacy(req.params.projectId, req.body ?? {})); });

  const media = async (req, res) => {
    const opened = await store.openVersion(req.params.projectId, req.params.versionId);
    try {
      if (req.query.download === '1') {
        const ascii = opened.downloadName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
        res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(opened.downloadName)}`);
      }
      await sendMedia(req, res, opened.path, opened.handle);
    } catch (e) {
      await opened.handle.close().catch(() => {});
      throw e;
    }
  };
  route('get', P + '/versions/:versionId/media', media);
  route('head', P + '/versions/:versionId/media', media);

  router.use((_req, res) => res.status(404).json({error: '项目音乐接口不存在', code: 'MUSIC_ROUTE_NOT_FOUND'}));
  router.use((e, _req, res, next) => {
    if (res.headersSent) return next(e);
    if (e.type === 'entity.too.large') return res.status(413).json({error: '请求内容过大', code: 'BODY_TOO_LARGE'});
    if (e.type === 'entity.parse.failed') return res.status(400).json({error: '请求不是有效的 JSON', code: 'INVALID_JSON'});
    if (!e.status) console.error('[project-music]', e);
    res.status(e.status ?? 500).json({error: e.status ? e.message : '项目音乐处理失败，请稍后重试', code: e.code ?? 'MUSIC_ERROR', ...(e.details ? {details: e.details} : {})});
  });
  return router;
}
