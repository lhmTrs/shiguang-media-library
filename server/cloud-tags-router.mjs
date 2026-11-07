import { Router } from "express";

export function cloudTagsRouter(service) {
  const router = Router();
  const route = fn => (req, res) => Promise.resolve().then(() => fn(req)).then(value => res.json(value)).catch(error => {
    const status = [400,401,403,408,409,413,423,429,502,503].includes(error.status) ? error.status : 503;
    const code = /^[A-Z_]{1,64}$/.test(error.code || "") ? error.code : "TAG_SYNC_FAILED";
    res.status(status).json({ error: "标签同步未完成", code });
  });
  router.get("/me", route(() => service.me()));
  router.put("/policy", route(req => service.policy(req.body)));
  router.put("/entries", route(req => service.put(req.body)));
  router.get("/candidates", route(req => service.candidates(req.query.q || "")));
  router.post("/publish", route(req => service.publishAsset(req.body)));
  router.get("/cache", route(req => service.cached(req.query)));
  router.post("/sync", route(req => service.sync(req.body)));
  return router;
}
