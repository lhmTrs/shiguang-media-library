// 分镜视频绑定 v2：点镜看片的纯逻辑。这里只处理界面用的数据形状，不涉及接口路径或字段名。
export const REVIEW_FIELD_LABELS = Object.freeze({
  framing: '景别与角度', action: '画面与人物动作', camera: '摄影机设计', duration: '时长', first_frame: '第一帧状态',
  continuity: '连续性要求', sound: '声音与对白', presence: '人物在场', references: '参考图绑定',
  carried_dialogue: '承接对白', scene: '所在场景信息', shot_range: '绑定范围内增删镜头',
});

export const canPlayStatus = status => status === 'available' || status === 'unchecked';

export const MEDIA_STATUS_TEXT = Object.freeze({
  missing: '原视频文件缺失，请到生成视频页重新定位。',
  changed: '视频文件和登记时不一致，请到生成视频页核对。',
  untrusted: '这条视频还没有通过文件核对，请到生成视频页处理。',
  unsupported: '浏览器不支持这条视频的编码，可到生成视频页在访达中打开。',
});

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

/** 按绑定版本里排在前面的镜头时长累加。结果只是估算，片子并没有按镜切点。 */
export function estimateStart(clip, shotId) {
  const index = clip.shots.findIndex(shot => shot.shotId === shotId);
  if (index < 0) return { startMs: 0, estimatedMs: 0, state: 'not-bound' };
  const estimatedMs = clip.shots.slice(0, index).reduce((sum, shot) => sum + shot.durationMs, 0);
  if (clip.durationMs > 0 && estimatedMs >= clip.durationMs) return { startMs: 0, estimatedMs, state: 'beyond-end' };
  return { startMs: estimatedMs, estimatedMs, state: estimatedMs ? 'estimated' : 'start' };
}

export function startText(estimate) {
  if (estimate.state === 'estimated') return '约从 ' + clockLabel(estimate.startMs) + ' 起播，按分镜时长估算，不是准确切点';
  if (estimate.state === 'beyond-end') return '估算位置 ' + clockLabel(estimate.estimatedMs) + ' 超过片长，已从片头播放';
  if (estimate.state === 'not-bound') return '这条片子没有对应这一镜，从片头播放';
  return '从片头播放';
}

/** 打开时选一次：优先后端给的默认片子，其次采用的片子，最后是最新绑定的片子。 */
export function defaultClip(clips, summary) {
  const byId = id => (id ? clips.find(clip => clip.id === id) : undefined);
  const picked = byId(summary?.playVideoId) ?? byId(summary?.adopted?.videoId);
  if (picked) return picked;
  return clips.reduce((latest, clip) => (!latest || clip.boundAt > latest.boundAt ? clip : latest), null);
}

/** 只有这一镜有采用时才显示新片子数；没有采用时本来就播最新。 */
export const newClipCount = summary => (summary?.adopted && summary.newCount > 0 ? summary.newCount : 0);

export function selectionText(selection) {
  if (!selection) return '未采用（播最新）';
  return selection.videoName + (selection.kind === 'shot' ? '（单镜另选）' : '（整条采用）');
}

const currentShots = clip => clip.shots.filter(shot => shot.currentNumber !== null);

export function coveredShotsText(clip) {
  const shots = currentShots(clip);
  return shots.length ? shots.map(shot => '镜 ' + shot.currentNumber).join('、') : '当前稿没有这些镜头';
}

function changeRow(shot, summaries, after) {
  const before = summaries[shot.shotId]?.adopted ?? null;
  return { shotId: shot.shotId, number: shot.currentNumber, before, after, beforeText: selectionText(before), afterText: selectionText(after) };
}

/**
 * 计算一次采用或取消的前后对比。
 * action.type: adopt-video | adopt-shot | clear-shot | clear-video
 * needsConfirm 只在会动到「当前这一镜以外」已有的不同选择时为真。
 */
export function selectionChanges(action, clip, shotId, summaries) {
  const adopted = { videoId: clip.id, videoName: clip.name, kind: action === 'adopt-shot' ? 'shot' : 'video' };
  const shots = currentShots(clip);
  const here = shots.find(shot => shot.shotId === shotId) ?? { shotId, currentNumber: summaries[shotId]?.number ?? '' };
  let rows;
  if (action === 'adopt-video') rows = shots.map(shot => changeRow(shot, summaries, adopted));
  else if (action === 'adopt-shot') rows = [changeRow(here, summaries, adopted)];
  else if (action === 'clear-shot') rows = [changeRow(here, summaries, null)];
  else rows = shots.filter(shot => summaries[shot.shotId]?.adopted?.videoId === clip.id).map(shot => changeRow(shot, summaries, null));
  const needsConfirm = rows.some(row => row.shotId !== shotId && row.before && row.before.videoId !== row.after?.videoId);
  return { rows, needsConfirm };
}
