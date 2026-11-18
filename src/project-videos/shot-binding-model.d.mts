export type BindingProject = { id: string; name: string; project_kind?: string; series_id?: string | null; season_id?: string | null; episode_no?: number | null };
export type BindingShot = { shotId: string; boundNumber: string; currentNumber: string | null };
export type VideoBinding = {
  projectId: string; projectName: string; revision: number; bindingRevision: number;
  origin: 'auto' | 'manual'; boundAt: number; needsReview: boolean; reviewFields: string[]; shots: BindingShot[];
};
export type EpisodeShot = { id: string; number: string; sceneIndex: number; sceneName: string; durationMs: number; summary: string };
export function episodeLabel(project: BindingProject): string;
export function episodeChoices<T extends BindingProject>(projects: T[], ownProjectId: string, boundProjectId?: string | null): T[];
export function initialShotIds(binding: VideoBinding | null, projectId: string, rows: EpisodeShot[]): string[];
export function orderedShotIds(rows: EpisodeShot[], selected: Set<string>): string[];
export function boundText(binding: VideoBinding | null, projects: BindingProject[]): string;
export function nextText(project: BindingProject, revision: number, rows: EpisodeShot[], selected: Set<string>): string;
export function sameBinding(binding: VideoBinding | null, projectId: string, revision: number, shotIds: string[]): boolean;
