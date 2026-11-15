// 素材使用页：结果不明的写请求（待核对）按范围保存的规则。纯函数，无依赖，便于单测。
// 每条时间线一格（关联/解除），每类项目级操作一格（准备成片文件夹、刷新视频信息）。
// 只认「登记中」的请求：发请求前 beginPending 登记，有明确结果（完成、失败、业务拒绝）时注销。
// 回执只能更新自己原意图那一格；不在登记里的请求（已结束的、从没登记过的）迟到的任何回执都忽略。
// 登记表只装还没结果的请求，不保存历史，所以没有条数上限造成的「旧结果复活」。

export type PendingIntent = { requestId: string; projectId: string; timelineId: string | null; action: string };
export type PendingState<P extends { intent: PendingIntent }> = { slots: Record<string, P>; live: string[] };

export const scopeOf = (i: PendingIntent) => i.timelineId ? `timeline:${i.projectId}:${i.timelineId}` : `project:${i.projectId}:${i.action}`;
export const emptyPending = <P extends { intent: PendingIntent }>(): PendingState<P> => ({ slots: {}, live: [] });

/** 发请求前登记原意图。 */
export function beginPending<P extends { intent: PendingIntent }>(state: PendingState<P>, intent: PendingIntent): PendingState<P> {
  return state.live.includes(intent.requestId) ? state : { ...state, live: [...state.live, intent.requestId] };
}

/** p 为 null 表示这条原意图已有明确结果：注销，并只在格里是自己时清掉。 */
export function applyPending<P extends { intent: PendingIntent }>(state: PendingState<P>, intent: PendingIntent, p: P | null): PendingState<P> {
  if (!state.live.includes(intent.requestId)) return state;
  const key = scopeOf(intent), current = state.slots[key];
  if (!p) {
    const slots = { ...state.slots };
    if (current?.intent.requestId === intent.requestId) delete slots[key];
    return { slots, live: state.live.filter(id => id !== intent.requestId) };
  }
  if (current && current.intent.requestId !== intent.requestId) return state;
  return { ...state, slots: { ...state.slots, [key]: p } };
}
