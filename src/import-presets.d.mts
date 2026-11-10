export function imageNamePreset(fileName: string, kind?: 'character' | 'scene' | 'prop'): {name: string; lookName: string; structured: boolean; generated: boolean};
type MediaKind = 'image' | 'video' | 'music' | 'sfx';
type Target = {projectId: string; folderId: string};
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
export function readImportTarget(libraryId: string | undefined, kind: MediaKind, projects: {id: string}[], storage?: Storage): Target | null;
export function rememberImportTarget(libraryId: string | undefined, kind: MediaKind, target: Target, storage?: Storage): void;
export function classificationParent(directory: string): string;
