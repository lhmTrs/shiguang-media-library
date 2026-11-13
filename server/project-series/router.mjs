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
      if (!(error instanceof SeriesError) && !['ASSET_IN_USE', 'ASSET_SCOPE_CHANGED', 'ASSET_NAME_CONFLICT', 'STORYBOARD_GENERATION_LOCKED'].includes(error.code) && !(typeof error.code === 'string' && error.code.startsWith('ATTRIBUTE_'))) return next(error);
      return res.status(error.status ?? 409).json({ error: error.message, code: error.code, details: error.details });
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
  router.post(base + "/organize/preview", handle(req => series.previewOrganize(req.body), true));
  router.post(base + "/organize", handle(req => series.organize(req.body), true));
  router.post(base + "/moves/:requestId/undo", handle(req => series.undo(req.params.requestId, req.body), true));
  const alignment = drama + "/attribute-alignment";
  router.get(alignment, handle(req => series.attributeAlignment.status(req.params.seriesId)));
  router.post(alignment + "/preview", handle(req => series.attributeAlignment.preview(req.params.seriesId, req.body), true));
  router.post(alignment + "/confirm", handle(req => series.attributeAlignment.confirm(req.params.seriesId, req.body), true));
  router.get(alignment + "/history", handle(req => series.attributeAlignment.history("series", req.params.seriesId, req.query)));
  router.get(alignment + "/history/:historyId", handle(req => series.attributeAlignment.history("series", req.params.seriesId, req.query, req.params.historyId)));
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
