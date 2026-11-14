// 生成视频页：按剧集规则改过名的视频，在本集里不再重复显示「剧名SxxEyy_」这段前缀。
// 只影响显示；悬停、搜索和所有数据仍用全名。拼法与收纳命名规则一致（非法字符和首尾的点、空格换成 -）。
const clean = value => value.normalize('NFC')
  .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '-')
  .replace(/^[. ]+|[. ]+$/g, m => '-'.repeat(m.length));
const pad = n => String(n).padStart(2, '0');

/** 「剧名S02E05_」；不在季里的散集是「剧名EP12_」。 */
export function episodeFilePrefix(seriesName, seasonNo, episodeNo) {
  if (!seriesName || !Number.isInteger(episodeNo) || episodeNo < 1) return null;
  return clean(seriesName) + (Number.isInteger(seasonNo) ? 'S' + pad(seasonNo) + 'E' + pad(episodeNo) : 'EP' + pad(episodeNo)) + '_';
}

/** A project's prefix from the grouped project list and the series list; null when it is not an episode. */
export function prefixForProject(project, seriesList) {
  if (!project?.series_id || project.episode_no == null) return null;
  const series = seriesList?.find(s => s.id === project.series_id);
  if (!series) return null;
  const season = project.season_id ? series.seasons?.find(s => s.id === project.season_id) : null;
  if (project.season_id && !season) return null;
  return episodeFilePrefix(series.name, season ? season.season_no : null, project.episode_no);
}

/** The name without this episode's prefix; any other name (original names, other episodes) is shown as is. */
export function shortVideoName(name, prefix) {
  if (!prefix || typeof name !== 'string') return name;
  const full = name.normalize('NFC'), head = prefix.normalize('NFC');
  return full.length > head.length && full.slice(0, head.length).toLocaleLowerCase() === head.toLocaleLowerCase() ? full.slice(head.length) : name;
}
