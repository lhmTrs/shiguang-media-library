import type {MigrationView} from '../storyboard/shot-video-model.mjs';
import type {AffectedBindingShot, BindingIntent, BindingPreview as V2BindingPreview, SourceVideoBinding, UnbindShotRef} from '../storyboard/video-binding-v2-types';

export type {BindingIntent, UnbindShotRef};

export type BindingProject = { id: string; name: string; project_kind?: string; series_id?: string | null; season_id?: string | null; episode_no?: number | null };
export type BindingTarget = { projectId: string; name: string; seriesId: string | null };
export type TargetChoice = BindingProject & { selectable: boolean };
export type BindingShot = { shotId: string; boundNumber: string; currentNumber: string | null };
export type VideoBinding = {
  bindingId: string; projectId: string; projectName: string; revision: number; bindingRevision: number;
  origin: 'agent' | 'manual'; provenanceRevision: number | null; boundAt: number; needsReview: boolean; shots: BindingShot[];
};
export type BindingRead = { bindingRevision: number | null; targets: BindingTarget[]; binding: VideoBinding | null; migration: MigrationView | null };
export type EpisodeShot = { id: string; number: string; sceneIndex: number; sceneName: string; durationMs: number; summary: string };
export type AffectedRow = AffectedBindingShot & { beforeText: string; afterText: string };
export type BindingPreview = { previewHash: string; requiresConfirmation: boolean; rows: AffectedRow[] };
export function episodeLabel(project: BindingProject): string;
export function targetChoices(targets: BindingTarget[], projects: BindingProject[], boundProjectId?: string | null, boundProjectName?: string): TargetChoice[];
export function bindingFromResponse(body: SourceVideoBinding): BindingRead;
export function bindingOriginText(binding: VideoBinding): string;
export function bindIntent(expectedBindingRevision: number, projectId: string, episode: { revision: number; assetStamp: string | null }, shotIds: string[]): BindingIntent;
export function unbindIntent(expectedBindingRevision: number): BindingIntent;
export function previewFromResponse(body: V2BindingPreview): BindingPreview;
export function releasedShotRefs(rows: AffectedRow[]): UnbindShotRef[];
export function unbindConfirmation(shots?: { id: string; shotId?: string; projectId?: string }[]): { confirmedUnbindShotRefs: UnbindShotRef[] } | { confirmedUnbindShotIds: string[] };
export function initialShotIds(binding: VideoBinding | null, projectId: string, rows: EpisodeShot[]): string[];
export function orderedShotIds(rows: EpisodeShot[], selected: Set<string>): string[];
export function boundText(binding: VideoBinding | null, projects: BindingProject[]): string;
export function nextText(project: BindingProject, revision: number, rows: EpisodeShot[], selected: Set<string>): string;
export function sameBinding(binding: VideoBinding | null, projectId: string, revision: number, shotIds: string[]): boolean;
export function adoptedShotsText(shots?: { number: number | string; projectId?: string; projectName?: string }[]): string;
