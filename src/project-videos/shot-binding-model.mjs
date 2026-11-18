// 分镜视频绑定 v2：生成视频页「对应到分镜镜头…」的纯逻辑，不涉及接口路径或字段名。
const collator = new Intl.Collator('zh-CN', { numeric: true });

export function episodeLabel(project) {
  return (project.episode_no == null ? '' : '第 ' + project.episode_no + ' 集 · ') + project.name;
}

/** 可选的集：片子所在项目 + 同剧其它集；已绑定到别处时也列出，保证能看到现状。 */
export function episodeChoices(projects, ownProjectId, boundProjectId = null) {
  const own = projects.find(project => project.id === ownProjectId);
  const list = projects.filter(project => project.id === ownProjectId || project.id === boundProjectId
    || (own?.series_id && project.series_id === own.series_id && (project.project_kind ?? 'normal') === 'normal'));
  return [...list].sort((a, b) => collator.compare(a.season_id ?? '', b.season_id ?? '')
    || (a.episode_no ?? Number.MAX_SAFE_INTEGER) - (b.episode_no ?? Number.MAX_SAFE_INTEGER)
    || collator.compare(a.name, b.name));
}

/** 已绑定镜头里，当前选中的这一集还存在的那些。 */
export function initialShotIds(binding, projectId, rows) {
  if (!binding || binding.projectId !== projectId) return [];
  const present = new Set(rows.map(row => row.id));
  return binding.shots.filter(shot => present.has(shot.shotId)).map(shot => shot.shotId);
}

/** 按分镜顺序保存，与勾选先后无关；估算起播依赖这个顺序。 */
export const orderedShotIds = (rows, selected) => rows.filter(row => selected.has(row.id)).map(row => row.id);

export function boundText(binding, projects) {
  if (!binding) return '还没有对应镜头';
  const project = projects.find(item => item.id === binding.projectId);
  const shots = binding.shots.map(shot => '镜 ' + shot.boundNumber + (shot.currentNumber === null ? '（已不在当前稿）'
    : shot.currentNumber !== shot.boundNumber ? '（现为镜 ' + shot.currentNumber + '）' : '')).join('、');
  return (project ? episodeLabel(project) : binding.projectName) + ' · 第 ' + binding.revision + ' 版 · ' + (shots || '没有镜头');
}

export function nextText(project, revision, rows, selected) {
  const numbers = rows.filter(row => selected.has(row.id)).map(row => '镜 ' + row.number);
  return episodeLabel(project) + ' · 第 ' + revision + ' 版 · ' + (numbers.join('、') || '没有镜头');
}

export function sameBinding(binding, projectId, revision, shotIds) {
  return !!binding && binding.projectId === projectId && binding.revision === revision
    && binding.shots.length === shotIds.length && binding.shots.every((shot, index) => shot.shotId === shotIds[index]);
}
