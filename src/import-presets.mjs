// Suggestions only. An explicitly chosen project, person or look always wins.
export function imageNamePreset(fileName, kind = 'character') {
  const stem = String(fileName).replace(/\.[^.]+$/, '').trim();
  const generated = /^(?:(?:IMG|DSC|DSCF|PXL|VID|DJI|image|photo|screenshot|屏幕截图)[_ -]?\d|[a-f\d]{24,}$|\d[\d_ -]{7,}$|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$)/i.test(stem);
  const index = stem.indexOf('_');
  const name = index > 0 ? stem.slice(0, index).trim() : '';
  const look = index > 0 ? stem.slice(index + 1).trim() : '';
  const structured = kind === 'character' && !generated && !!name && !!look;
  return {name: structured ? name : generated ? '' : stem, lookName: structured ? look : '默认', structured, generated};
}

// These are optional, library-scoped convenience values, never submission receipts.
// Do not remember source removal, authentication, or an unconfirmed draft here.
const keyFor = (libraryId, kind) => libraryId && ['image', 'video', 'music', 'sfx'].includes(kind)
  ? `shiguang.importTarget.v1:${encodeURIComponent(libraryId)}:${kind}` : null;
const validId = value => typeof value === 'string' && !!value && value.length <= 180 && !/[\u0000-\u001f/\\]/.test(value);
export function readImportTarget(libraryId, kind, projects, storage) {
  try {
    const key = keyFor(libraryId, kind);
    if (!key) return null;
    const value = JSON.parse((storage ?? globalThis.localStorage).getItem(key) || 'null');
    return value && validId(value.projectId) && validId(value.folderId) && projects.some(p => p.id === value.projectId)
      ? {projectId: value.projectId, folderId: value.folderId} : null;
  } catch { return null; }
}
export function rememberImportTarget(libraryId, kind, target, storage) {
  try {
    const key = keyFor(libraryId, kind);
    if (key && validId(target.projectId) && validId(target.folderId))
      (storage ?? globalThis.localStorage).setItem(key, JSON.stringify({projectId: target.projectId, folderId: target.folderId}));
  } catch { /* Optional preferences must never prevent importing. */ }
}

// Pending is a virtual view of files in the root, not a writable child folder.
export const classificationParent = directory => directory === '\u0000pending' ? '' : directory;
