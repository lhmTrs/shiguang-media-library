export type SegmentMode = 'seedance_2_5' | 'seedance_2_0' | 'camera' | 'custom';
export interface SegmentSettings { mode: SegmentMode; custom_limit_ms: number | null }
export interface Segment { id: string; name: string; start_shot_id: string }
export interface SegmentProject { document_id?: string; project_id?: string; scenes: {shots: {id: string; duration_ms: number; [key: string]: unknown}[]; [key: string]: unknown}[]; segments?: Segment[]; segment_settings?: SegmentSettings; segment_used_names?: string[]; segment_used_ids?: string[]; [key: string]: unknown }
export type Segmented<T> = T & {segments: Segment[]; segment_settings: SegmentSettings; segment_used_names: string[]; segment_used_ids: string[]};
export interface SegmentSummaryRow extends Segment {end_shot_id: string; start_number: string; end_number: string; shot_ids: string[]; shot_count: number; duration_ms: number; overlong: boolean}
export interface SegmentSummary {segment_settings: SegmentSettings; limit_ms: number | null; used_names: string[]; used_ids: string[]; segments: SegmentSummaryRow[]}
export interface Insertion {shot_id: string; anchor_shot_id: string; side: 'before' | 'after'}
export interface SegmentEvent {type: 'add' | 'remove' | 'move_start' | 'overwrite'; segment_id: string; name: string; before: {start_shot_id: string; start_number: string} | null; after: {start_shot_id: string; start_number: string} | null; previous_name?: string; merged_into?: {id: string; name: string}}
export const SEGMENT_MODES: readonly SegmentMode[];
export function segmentNameParts(name: string): {base: string; suffix: string | null; order: bigint};
export function compareSegmentNames(a: string,b: string): number;
export function getSegmentLimit(settings?: SegmentSettings): number | null;
export function withSegments<T extends SegmentProject>(project: T): Segmented<T>;
export function validateSegmentStructure<T extends SegmentProject>(project: T): T;
export function segmentSummary(project: SegmentProject): SegmentSummary;
export function nextSegmentName(project: SegmentProject,segmentId: string): string;
export function nearestEmptyBase(project: SegmentProject,segmentId: string): string | null;
export function splitSegment<T extends SegmentProject>(project: T,shotId: string,options: {id: string; name?: string}): Segmented<T>;
export function mergeSegment<T extends SegmentProject>(project: T,segmentId: string): Segmented<T>;
export function reconcileSegmentCuts<T extends SegmentProject>(before: SegmentProject,next: T,options?: {insertions?: Insertion[]; firstSegmentId?: string}): Segmented<T>;
export function validateSegmentSave<T extends SegmentProject>(previous: SegmentProject | null,candidate: T,options?: {kind?: 'save' | 'initialize' | 'restore'; author?: string; overwrites?: {segment_id: string; name: string}[]}): Segmented<T>;
export function segmentChanges(before: SegmentProject | null,after: SegmentProject | null): SegmentEvent[];
