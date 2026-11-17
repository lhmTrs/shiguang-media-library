// 分镜「段」：规则全部来自后端共享纯函数（BACKEND-FROZEN-v1），前端只做显示文案。
export { SEGMENT_MODES, getSegmentLimit, withSegments, segmentSummary, nextSegmentName, nearestEmptyBase, splitSegment, mergeSegment, reconcileSegmentCuts } from '../../server/storyboard/shared/segments.mjs';
import type { SegmentMode } from '../../server/storyboard/shared/segments.mjs';
export type { SegmentMode };

export const MODE_LABEL: Record<SegmentMode, string> = {
  seedance_2_5: 'Seedance 2.5 · 30 秒',
  seedance_2_0: 'Seedance 2.0 · 15 秒',
  camera: '摄影模式 · 不限时长',
  custom: '自定义秒数',
};

export function modeLabel(settings: { mode?: string; custom_limit_ms?: number | null } | undefined) {
  const mode = (settings?.mode ?? 'seedance_2_5') as SegmentMode;
  if (mode === 'custom') return settings?.custom_limit_ms ? `自定义 · ${trimSeconds(settings.custom_limit_ms)} 秒` : '自定义秒数（未填）';
  return MODE_LABEL[mode] ?? mode;
}

export function trimSeconds(ms: number) { return String(Number((ms / 1000).toFixed(3))); }

export const newSegmentId = () => 'segment_' + crypto.randomUUID();

type SegSide = { name?: string; start_shot_id?: string | null; start_number?: string | number | null } | null | undefined;
const num = (s: SegSide) => s?.start_number != null && s.start_number !== '' ? '镜 ' + String(s.start_number).padStart(2, '0') : '某一镜';
/** 合同里的 segment_event → 一句话（改动记录、待看用）。 */
export function segmentEventText(ev: { type: string; name?: string; before?: SegSide; after?: SegSide; previous_name?: string; merged_into?: { id?: string; name?: string } | null } | null | undefined): string {
  if (!ev) return '段有变化';
  const name = ev.name ?? ev.after?.name ?? ev.before?.name ?? '';
  switch (ev.type) {
    case 'add': return `从${num(ev.after)} 起切出新段 ${name}`;
    case 'remove': return ev.merged_into?.name ? `${name} 段并入 ${ev.merged_into.name} 段` : `${name} 段已删除`;
    case 'move_start': return `${name} 段的起点从${num(ev.before)} 挪到${num(ev.after)}`;
    case 'overwrite': return `新段用回空字母 ${name}，旧 ${name} 的资料作废`;
    case 'mode': return `分割模式改为 ${modeLabel(ev.after as never)}`;
    default: return `${name} 段有变化`;
  }
}
/** 待看条目只有改前/改后结构时，推出同样的一句话。 */
export function segmentDiffText(rawBefore: unknown, rawAfter: unknown, shotNumber?: (shotId: string) => string | undefined): string {
  const unwrap = (v: unknown): SegSide => { const x = (v && typeof v === 'object' && '$segment' in (v as object) ? (v as {$segment: SegSide}).$segment : v) as SegSide; return x && x.start_number == null && x.start_shot_id && shotNumber ? { ...x, start_number: shotNumber(x.start_shot_id) ?? null } : x; };
  const before = unwrap(rawBefore), after = unwrap(rawAfter);
  if (!before && after) return segmentEventText({ type: 'add', name: after.name, after });
  if (before && !after) return segmentEventText({ type: 'remove', name: before.name, before });
  if (before && after && before.start_shot_id !== after.start_shot_id) return segmentEventText({ type: 'move_start', name: after.name, before, after });
  return `${after?.name ?? before?.name ?? ''} 段有变化`;
}
