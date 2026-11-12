import { Router } from "express";
import { SeriesError } from "./store.mjs";

export function projectSeriesRouter(series) {
  const router = Router();
  const handle = (action, write = false) => (req, res, next) => {
    try {
      if (write && (!req.body || typeof req.body !== "object" || Array.isArray(req.body))) {
        throw new SeriesError("INVALID_SERIES_INPUT", "请求必须包含有效的表单资料", 400);
      }
      res.json(action(req));
    } catch (error) {
      if (!(error instanceof SeriesError)) return next(error);
      return res.status(error.status).json({ error: error.message, code: error.code, details: error.details });
    }
  };

  const base = "/project-series";
  const drama = base + "/:seriesId";
  const season = drama + "/seasons/:seasonId";
  router.get(base, handle(() => series.list()));
  router.post(base, handle(req => series.createSeries(req.body), true));
  router.get(base + "/requests/:requestId", handle(req => series.request(req.params.requestId)));
  router.post(base + "/moves/preview", handle(req => series.previewMove(req.body), true));
  router.post(base + "/moves", handle(req => series.move(req.body), true));
  router.post(base + "/moves/:requestId/undo", handle(req => series.undo(req.params.requestId, req.body), true));
  router.patch(drama, handle(req => series.updateSeries(req.params.seriesId, req.body), true));
  router.delete(drama, handle(req => series.removeSeries(req.params.seriesId, req.body), true));
  router.post(drama + "/seasons", handle(req => series.createSeason(req.params.seriesId, req.body), true));
  router.patch(season, handle(req => series.updateSeason(req.params.seriesId, req.params.seasonId, req.body), true));
  router.delete(season, handle(req => series.removeSeason(req.params.seriesId, req.params.seasonId, req.body), true));
  router.post(season + "/reorder", handle(req => series.reorderSeasons(req.params.seriesId, req.params.seasonId, req.body), true));
  router.post(drama + "/episodes", handle(req => series.createEpisode(req.params.seriesId, req.body), true));
  router.post("/projects/:projectId/series/reorder", handle(req => series.reorderEpisodes(req.params.projectId, req.body), true));
  return router;
}
