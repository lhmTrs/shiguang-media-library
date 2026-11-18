// 分镜视频绑定 v2：点镜看片的纯逻辑。字段按 STORYBOARD-VIDEO-BINDING-V2 合同 v1。
export const REVIEW_REASON_LABELS = Object.freeze({
  framing: '景别与角度', action: '画面与人物动作', camera: '摄影机设计', duration: '时长', first_frame: '第一帧状态',
  continuity: '连续性要求', sound_dialogue: '声音与对白', characters: '人物在场', references: '参考图绑定',
  audio_continuation: '承接对白', scene: '所在场景信息', shot_range: '绑定范围内增删镜头',
  video_content: '片子内容变了', dependency_unverifiable: '有依赖无法核对',
});

export const reviewReasonText = reasons => [...new Set((reasons ?? []).map(reason => REVIEW_REASON_LABELS[reason.category] ?? reason.category))].join('、');

export const canPlayStatus = status => status === 'available' || status === 'unchecked';

export const MEDIA_STATUS_TEXT = Object.freeze({
  missing: '原视频文件缺失，请到生成视频页重新定位。',
  changed: '视频文件和登记时不一致，请到生成视频页核对。',
  untrusted: '这条视频还没有通过文件核对，请到生成视频页处理。',
  unsupported: '浏览器不支持这条视频的编码，可到生成视频页在访达中打开。',
});

const V2_ERROR_TEXT = Object.freeze({
  VIDEO_V2_INVALID_INPUT: '提交的内容不完整，请重新操作。',
  VIDEO_V2_NOT_FOUND: '片子或绑定已不存在，请刷新后再看。',
  SHOT_NOT_FOUND: '这个镜头已不在当前分镜里。',
  VIDEO_BINDING_CONFLICT: '绑定刚被改过，这次没有写入。',
  VIDEO_SELECTION_CONFLICT: '采用刚被改过，这次没有写入。',
  STORYBOARD_CONFLICT: '分镜刚被改过，这次没有写入。',
  ASSET_CONTEXT_CHANGED: '参考图或造型刚被改过，这次没有写入。',
  VIDEO_ORIGIN_CONFLICT: '这条片子已有不同的来历记录，这次没有写入。',
  VIDEO_REVIEW_CONFLICT: '内容刚有变化，这次复核没有写入。',
  VIDEO_TARGET_SCOPE_CHANGED: '这一集已不在可选范围里。',
  REQUEST_ID_CONFLICT: '这次操作和之前的请求不一致，请重新操作。',
  VIDEO_REPLACEMENT_CONFIRMATION_REQUIRED: '这次会替换已有的采用，需要先确认。',
  UNBIND_CONFIRMATION_REQUIRED: '要解除的采用有变化，请重新确认。',
  VIDEO_UNBIND_SCOPE_REQUIRED: '有相同镜头涉及多集，请重新确认。',
  VERSION_PRUNED: '绑定用到的分镜版本已不在历史里。',
  VIDEO_V2_MIGRATION_REQUIRED: '片子绑定数据需要先升级，暂时不能读取或修改。',
  VIDEO_V2_UNSETTLED: '片子绑定数据正在处理，请稍后再试。',
});

/** 优先用后端的说明；通用请求层拿不到说明时按错误码给中文。 */
export function v2ErrorText(code, message, fallback = '操作没有完成，请重试') {
  return message && message !== '请求失败' ? message : V2_ERROR_TEXT[code] ?? fallback;
}

export function clockLabel(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}

/** 只接受同源 /api/ 下的播放地址。 */
export function safeMediaUrl(url, origin) {
  try {
    const parsed = new URL(url, origin);
    return parsed.origin === origin && parsed.pathname.startsWith('/api/') ? parsed.href : '';
  } catch { return ''; }
}

/**
 * 按绑定版本里排在前面的镜头时长累加。结果只是估算，片子并没有按镜切点。
 * mediaMs 是实际片长（读到媒体信息后传入）；估算超过片长时截到片尾前 1 秒。
 */
export function estimateStart(clip, shotId, mediaMs = clip.durationMs) {
  const index = clip.shots.findIndex(shot => shot.shotId === shotId);
  if (index < 0) return { startMs: 0, estimatedMs: 0, state: 'not-bound' };
  const estimatedMs = clip.shots.slice(0, index).reduce((sum, shot) => sum + Math.max(0, shot.durationMs), 0);
  if (mediaMs > 0 && estimatedMs >= mediaMs) return { startMs: Math.max(0, mediaMs - 1000), estimatedMs, state: 'beyond-end' };
  return { startMs: estimatedMs, estimatedMs, state: estimatedMs ? 'estimated' : 'start' };
}

export function startText(estimate) {
  if (estimate.state === 'estimated') return '约从 ' + clockLabel(estimate.startMs) + ' 起播，按分镜时长估算，不是准确切点';
  if (estimate.state === 'beyond-end') return '估算位置 ' + clockLabel(estimate.estimatedMs) + ' 超过片长，已跳到片尾附近';
  if (estimate.state === 'not-bound') return '这条片子没有对应这一镜，从片头播放';
  return '从片头播放';
}

/**
 * 打开时选一次：后端算好的默认片子优先。
 * 有采用但列表里找不到时返回 null，不悄悄换成别的片子。列表已按绑定先后倒序，第一条就是最新。
 */
export function defaultClip(clips, summary) {
  const byId = id => (id ? clips.find(clip => clip.id === id) : undefined);
  const picked = byId(summary?.playVideoId);
  if (picked) return picked;
  if (summary?.adopted) return byId(summary.adopted.videoId) ?? null;
  return clips[0] ?? null;
}

/** 只有这一镜有采用时才显示新片子数；没有采用时本来就播最新。 */
export const newClipCount = summary => (summary?.adopted && summary.newCount > 0 ? summary.newCount : 0);

export function selectionText(selection) {
  if (!selection) return '未采用（播最新）';
  return selection.name + (selection.kind === 'shot' ? '（单镜另选）' : '（整条采用）');
}

const currentShots = clip => clip.shots.filter(shot => shot.currentNumber !== null);

export function coveredShotsText(clip) {
  const shots = currentShots(clip);
  return shots.length ? shots.map(shot => '镜 ' + shot.currentNumber).join('、') : '当前稿没有这些镜头';
}

/** 这条片子覆盖的当前镜头是否都已经整条采用它。 */
export function wholeAdopted(clip, summaries) {
  const shots = currentShots(clip);
  return shots.length > 0 && shots.every(shot => {
    const adopted = summaries[shot.shotId]?.adopted;
    return adopted?.videoId === clip.id && adopted.kind === 'whole';
  });
}

/** 来历说明：手动补录不能写成“照某版生成”，也不捏造生成版本。 */
export function originText(clip) {
  if (clip.origin === 'agent') return '照第 ' + clip.boundRevision + ' 版分镜 · 生成时记录';
  if (clip.provenanceRevision !== null) return '手动对应到第 ' + clip.boundRevision + ' 版分镜 · 原生成出处第 ' + clip.provenanceRevision + ' 版';
  return '手动补录到第 ' + clip.boundRevision + ' 版分镜 · 没有生成出处';
}

export function summariesFromState(state) {
  return {
    initialized: !!state.initialized,
    selectionRevision: state.context?.selectionRevision ?? 0,
    storyboardRevision: state.context?.storyboardRevision ?? 0,
    shots: Object.fromEntries(state.shots.map(shot => [shot.shotId, {
      number: shot.number, adopted: shot.adopted, playVideoId: shot.defaultVideo?.videoId ?? null,
      candidateCount: shot.candidateCount, newCount: shot.newVideoCount, needsReview: shot.needsReview,
    }])),
  };
}

export function clipFromItem(item) {
  const { binding, review } = item;
  return {
    id: item.videoId, sourceProjectId: item.sourceProjectId, name: item.name, durationMs: item.durationMs, status: item.status, mediaUrl: item.mediaUrl,
    bindingId: binding.bindingId, bindingRevision: binding.revision, boundRevision: binding.storyboardRevision, boundAt: binding.boundAt,
    origin: binding.origin, provenanceRevision: binding.provenance?.storyboardRevision ?? null,
    needsReview: !!review?.needsReview, reviewReasons: review?.reasons ?? [],
    review: review?.reviewedToRevision == null ? null : { revision: review.reviewedToRevision, at: review.reviewedAt },
    comparisonHash: review?.comparisonHash ?? null, canReview: !!review?.canReview, reviewBlockedReason: review?.disabledReason ?? null,
    shots: binding.shots.map(shot => ({ shotId: shot.shotId, boundNumber: shot.numberAtBinding, durationMs: shot.durationMs, currentNumber: shot.existsInCurrent ? shot.currentNumber : null })),
  };
}

export function rowsFromChanges(changes) {
  return changes.map(({ projectId, shotId, number, before, after }) => ({ projectId, shotId, number, before, after, beforeText: selectionText(before), afterText: selectionText(after) }));
}

/** 合同第 5 节的采用意图：每种操作只带它需要的字段。 */
export function selectionIntent(action, clip, shotId, context) {
  const base = { action, expectedSelectionRevision: context.selectionRevision, expectedStoryboardRevision: context.storyboardRevision };
  if (action === 'clear-shot') return { ...base, shotId };
  const video = { sourceProjectId: clip.sourceProjectId, videoId: clip.id, bindingId: clip.bindingId, expectedBindingRevision: clip.bindingRevision };
  return action === 'adopt-shot' ? { ...base, ...video, shotId } : { ...base, ...video };
}
