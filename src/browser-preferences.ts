export const viewPaths: Record<string, string> = {
  all: 'materials', photo: 'photos', video: 'videos', sfx: 'sound-effects', music: 'music', favorites: 'favorites',
  projects: 'projects', projectUsage: 'project-usage', projectAssets: 'project-assets', projectVideos:'project-videos', storyboard: 'storyboards', promptTemplates: 'prompt-templates',
  categoryManagement: 'categories', tagManagement: 'tags', duplicates: 'duplicates', review: 'review', offline: 'offline', missing: 'missing',
};
export const groupDefaults = { find: true, design: true, manage: false, roots: true };
export const navigationGroupsKey = 'shiguang.navigationGroups.v1';
export const memoryKey = 'shiguang.browserMemory.v1';
export type BrowserMemory = { location: boolean; navigation: boolean; display: boolean };
export const memoryDefaults: BrowserMemory = { location: true, navigation: true, display: true };

export type ProjectLocation = { projectId: string; recent: string[]; lastInContainer: Record<string, string> };
export const emptyProjectLocation: ProjectLocation = { projectId: '', recent: [], lastInContainer: {} };
export const recentProjectLimit = 10;
const projectLocationPrefix = 'shiguang.projectLocation.v1:';
const legacyProjectKey = 'shiguang.activeProject';
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function readProjectLocation(libraryId: string): ProjectLocation {
  const saved = readStored<Record<string, unknown> | null>(projectLocationPrefix + libraryId, null, isRecord);
  if (!saved) return { ...emptyProjectLocation, projectId: readTextPreference(legacyProjectKey) ?? '' };
  const recent = Array.isArray(saved.recent)
    ? [...new Set(saved.recent.filter((id): id is string => typeof id === 'string' && id.length > 0))].slice(0, recentProjectLimit)
    : [];
  const lastInContainer = isRecord(saved.lastInContainer)
    ? Object.fromEntries(Object.entries(saved.lastInContainer).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : {};
  return { projectId: typeof saved.projectId === 'string' ? saved.projectId : '', recent, lastInContainer };
}

export function saveProjectLocation(libraryId: string, location: ProjectLocation) {
  saveStored(projectLocationPrefix + libraryId, location);
  removeStored(legacyProjectKey);
}

export function clearProjectLocations() {
  try {
    const keys = Object.keys(localStorage).filter(key => key.startsWith(projectLocationPrefix));
    removeStored(legacyProjectKey, ...keys);
  } catch {}
}

export function readStored<T>(key: string, fallback: T, validate: (value: unknown) => value is T): T {
  try { const value: unknown = JSON.parse(localStorage.getItem(key) || 'null'); return validate(value) ? value : fallback; } catch { return fallback; }
}
export function saveStored(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
export function removeStored(...keys: string[]) { try { keys.forEach(key => localStorage.removeItem(key)); } catch {} }
export function readMemory(): BrowserMemory {
  const saved = readStored<Record<string, unknown>>(memoryKey, {}, (v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v));
  return Object.fromEntries(Object.entries(memoryDefaults).map(([key, value]) => [key, typeof saved[key] === 'boolean' ? saved[key] : value])) as BrowserMemory;
}
export function viewFromHash(hash: string) { return Object.keys(viewPaths).find(view => hash === '#/' + viewPaths[view]) ?? null; }
export function viewHash(view: string) { return '#/' + (viewPaths[view] || viewPaths.all); }
export function initialView() {
  const explicit = viewFromHash(location.hash); if (explicit) return explicit;
  if (location.hash && !['#/login', '#/account'].includes(location.hash)) return 'all';
  if (readMemory().location) { try { const saved = localStorage.getItem('shiguang.lastView'); if (saved && Object.hasOwn(viewPaths, saved)) return saved; } catch {} }
  return 'all';
}
export function readGroups() {
  const saved = readMemory().navigation ? readStored<Record<string, unknown>>(navigationGroupsKey, {}, (v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)) : {};
  return Object.fromEntries(Object.entries(groupDefaults).map(([id, fallback]) => [id, typeof saved[id] === 'boolean' ? saved[id] : fallback]));
}
export function readLayouts() {
  const saved = readMemory().display ? readStored<Record<string, unknown>>('shiguang.assetLayouts.v1', {}, (v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)) : {};
  return Object.fromEntries(Object.entries(saved).filter(([id, layout]) => Object.hasOwn(viewPaths, id) && (layout === 'list' || layout === 'grid'))) as Record<string, 'list' | 'grid'>;
}
export function defaultLayout(view: string) { return view === 'photo' || view === 'video' ? 'grid' as const : 'list' as const; }
export type SearchPreferences = { mode: 'all' | 'any'; nameOnly: boolean; expanded: boolean };
export function readSearchPreferences(): SearchPreferences {
  if (!readMemory().display) return { mode: 'all', nameOnly: false, expanded: false };
  const value = readStored<Record<string, unknown>>('shiguang.searchPreferences.v1', {}, (v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v));
  return { mode: value.mode === 'any' ? 'any' : 'all', nameOnly: value.nameOnly === true, expanded: value.expanded === true };
}
export function readVolume() { return readMemory().display ? readStored('shiguang.volume', .7, (v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) : .7; }

export function readTextPreference(key: string) { try { return localStorage.getItem(key); } catch { return null; } }
export function saveTextPreference(key: string, value: string) { try { localStorage.setItem(key, value); } catch {} }
