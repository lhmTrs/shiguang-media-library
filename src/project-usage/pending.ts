// 素材使用页：结果不明的写请求（待核对）按范围保存的规则。纯函数，无依赖，便于单测。
// 每条时间线一格（关联/解除），每类项目级操作一格（准备成片文件夹、刷新视频信息）。
// 保存和清除都只能动「自己原意图」那一格：同范围已有另一条未决时不覆盖；已有明确终态的请求，迟到的任何回执都不再写回。

export type PendingIntent = { requestId: string; projectId: string; timelineId: string | null; action: string };
export type PendingState<P extends { intent: PendingIntent }> = { slots: Record<string, P>; settled: string[] };

export const scopeOf = (i: PendingIntent) => i.timelineId ? `timeline:${i.projectId}:${i.timelineId}` : `project:${i.projectId}:${i.action}`;
export const emptyPending = <P extends { intent: PendingIntent }>(): PendingState<P> => ({ slots: {}, settled: [] });

/** p 为 null 表示这条原意图已有明确终态（完成或失败）。 */
export function applyPending<P extends { intent: PendingIntent }>(state: PendingState<P>, intent: PendingIntent, p: P | null): PendingState<P> {
  if (state.settled.includes(intent.requestId)) return state;
  const key = scopeOf(intent), current = state.slots[key];
  if (!p) {
    const slots = { ...state.slots };
    if (current?.intent.requestId === intent.requestId) delete slots[key];
    return { slots, settled: [...state.settled, intent.requestId].slice(-200) };
  }
  if (current && current.intent.requestId !== intent.requestId) return state;
  return { ...state, slots: { ...state.slots, [key]: p } };
}
