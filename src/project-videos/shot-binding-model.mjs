// 分镜视频绑定 v2：生成视频页「对应到分镜镜头…」的纯逻辑。字段按 STORYBOARD-VIDEO-BINDING-V2 合同 v1。
import { selectionText } from '../storyboard/shot-video-model.mjs';

const collator = new Intl.Collator('zh-CN', { numeric: true });

/** 剧集项目的名字常已带“第N集”，这时不重复写。 */
export function episodeLabel(project) {
  const number = project.episode_no;
  return (number == null || project.name.replace(/\s/g, '').includes('第' + number + '集') ? '' : '第 ' + number + ' 集 · ') + project.name;
}

/** 可选的集以后端给的范围为准；已绑定的集不在范围里时也列出，但不能再选。 */
export function targetChoices(targets, projects, boundProjectId = null, boundProjectName = '') {
  const known = id => projects.find(project => project.id === id);
  const list = targets.map(target => ({ ...known(target.projectId), id: target.projectId, name: target.name, series_id: target.seriesId, selectable: true }));
  if (boundProjectId && !list.some(item => item.id === boundProjectId)) {
    const project = known(boundProjectId);
    list.push({ ...project, id: boundProjectId, name: project?.name ?? boundProjectName ?? '其它项目', selectable: false });
  }
  return list.sort((a, b) => collator.compare(a.season_id ?? '', b.season_id ?? '')
    || (a.episode_no ?? Number.MAX_SAFE_INTEGER) - (b.episode_no ?? Number.MAX_SAFE_INTEGER)
    || collator.compare(a.name, b.name));
}

export function bindingFromResponse(body) {
  const { binding, review } = body;
  const target = binding && body.allowedTargets.find(item => item.projectId === binding.targetProjectId);
  return {
    bindingRevision: body.bindingRevision,
    targets: body.allowedTargets,
    binding: binding && {
      bindingId: binding.bindingId, projectId: binding.targetProjectId, projectName: target?.name ?? '', revision: binding.storyboardRevision,
      bindingRevision: binding.revision, origin: binding.origin, provenanceRevision: binding.provenance?.storyboardRevision ?? null, boundAt: binding.boundAt,
      needsReview: !!review?.needsReview,
      shots: binding.shots.map(shot => ({ shotId: shot.shotId, boundNumber: shot.numberAtBinding, currentNumber: shot.existsInCurrent ? shot.currentNumber : null })),
    },
  };
}

export function bindingOriginText(binding) {
  if (binding.origin === 'agent') return '生成时记录';
  return binding.provenanceRevision !== null ? '手动修改 · 原生成出处第 ' + binding.provenanceRevision + ' 版' : '手动补录 · 没有生成出处';
}

export const bindIntent = (expectedBindingRevision, projectId, episode, shotIds) => ({
  action: 'bind', expectedBindingRevision, targetProjectId: projectId,
  expectedStoryboardRevision: episode.revision, expectedAssetStamp: episode.assetStamp, shotIds,
});

export const unbindIntent = expectedBindingRevision => ({
  action: 'unbind', expectedBindingRevision, targetProjectId: null, expectedStoryboardRevision: null, expectedAssetStamp: null, shotIds: [],
});

export function previewFromResponse(body) {
  const rows = body.affectedShots.map(({ projectId, projectName, shotId, number, before, after }) => ({ projectId, projectName, shotId, number, before, after, beforeText: selectionText(before), afterText: selectionText(after) }));
  return { previewHash: body.previewHash, requiresConfirmation: !!body.requiresConfirmation, rows };
}

/** 确认字段只列真正会被解除的采用；不同集可能有相同镜头 ID，所以带集。 */
export const releasedShotRefs = rows => rows.filter(row => row.before && !row.after).map(({ projectId, shotId }) => ({ projectId, shotId }));

/**
 * 生成视频页旧操作的解除确认：受影响镜头都带集时用复合引用，否则沿用旧的镜头 ID 列表。两个字段不同时发。
 * 同一条记录的 id 和 shotId 不一致说明数据有问题，不猜。
 */
export function unbindConfirmation(shots = []) {
  const ids = shots.map(shot => {
    if (shot.shotId !== undefined && shot.shotId !== shot.id) throw Error('受影响镜头的数据不一致，请刷新后重新确认');
    return shot.id;
  });
  return shots.length && shots.every(shot => shot.projectId)
    ? { confirmedUnbindShotRefs: shots.map((shot, index) => ({ projectId: shot.projectId, shotId: ids[index] })) }
    : { confirmedUnbindShotIds: ids };
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
  return (project ? episodeLabel(project) : binding.projectName || '其它项目') + ' · 第 ' + binding.revision + ' 版 · ' + (shots || '没有镜头');
}

export function nextText(project, revision, rows, selected) {
  const numbers = rows.filter(row => selected.has(row.id)).map(row => '镜 ' + row.number);
  return episodeLabel(project) + ' · 第 ' + revision + ' 版 · ' + (numbers.join('、') || '没有镜头');
}

export function sameBinding(binding, projectId, revision, shotIds) {
  return !!binding && binding.projectId === projectId && binding.revision === revision
    && binding.shots.length === shotIds.length && binding.shots.every((shot, index) => shot.shotId === shotIds[index]);
}

/** 受影响的采用可能跨集：带集名时按集分开写，同镜号不会混在一起。 */
export function adoptedShotsText(shots = []) {
  const groups = new Map();
  for (const shot of shots) {
    const key = shot.projectId ?? '';
    if (!groups.has(key)) groups.set(key, { name: shot.projectName ?? '', numbers: [] });
    groups.get(key).numbers.push('镜 ' + shot.number);
  }
  return [...groups.values()].map(group => (group.name ? group.name + '：' : '') + group.numbers.join('、')).join('；');
}
