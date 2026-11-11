// Pure routing suggestions for the simple intake window. Suggestions only:
// a user's explicit choice always wins, and the server re-validates every
// confirmed target. Nothing here creates projects, characters or folders.
import {imageNamePreset} from '../import-presets.mjs';

const SEP = /^[\s_\-—·.、,，:：()（）\[\]【】]+/;
// Names cameras, browsers and canvas platforms give by default. They never
// become a new character unless a character with that exact name exists.
const GENERIC = /^(canvas|img|image|images|dsc|dscf|pxl|photo|photos|pic|picture|output|download|downloads|下载|screenshot|screen shot|屏幕截图|截屏|截图|未命名|untitled|微信图片|mmexport|generated|gen)(?![\p{L}])/iu;

export const AUDIO_SFX_MAX = 60, AUDIO_MUSIC_MIN = 120;

export const stem = name => String(name).normalize('NFKC').replace(/\.[^.]+$/, '').trim();
const fold = s => String(s).normalize('NFKC').toLowerCase();
const rest = (text, head) => text.slice(head.length).replace(SEP, '');

/** Longest item whose name is a prefix of text (case-insensitive, NFKC). */
export function longestPrefix(items, text, nameOf = item => item.name) {
  const t = fold(text); let best = null, len = 0;
  for (const item of items || []) {
    const n = fold(nameOf(item) || '').trim();
    if (n && n.length > len && t.startsWith(n)) { best = item; len = n.length; }
  }
  return best;
}

export const isGenericName = name => GENERIC.test(stem(name));

/** Audio kind preset by duration in seconds; null when the user must choose. */
export function audioKindFor(durationSec, lastAudioKind) {
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec < 0) return null;
  if (durationSec < AUDIO_SFX_MAX) return {kind: 'sfx', reason: '按时长预选为音效'};
  if (durationSec <= AUDIO_MUSIC_MIN) return lastAudioKind === 'sfx' || lastAudioKind === 'music'
    ? {kind: lastAudioKind, reason: '按上次选择预选为' + (lastAudioKind === 'sfx' ? '音效' : '音乐')}
    : {kind: 'music', reason: '按时长预选为音乐'};
  return {kind: 'music', reason: '按时长预选为音乐'};
}

export function formatDuration(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec)) return '';
  const s = Math.round(sec), m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

const validProject = (options, id) => id ? options.projects.find(p => p.id === id) || null : null;
const assetsOf = (project, kinds) => (project?.assets || []).filter(a => kinds.includes(a.kind));

/** Match a photo name inside one project: scene/prop, then existing character. */
function matchInProject(project, text) {
  const asset = longestPrefix(assetsOf(project, ['scene', 'prop']), text);
  if (asset) return {type: 'asset', asset};
  const character = longestPrefix(assetsOf(project, ['character']), text);
  if (character) {
    const tail = rest(text, character.name.normalize('NFKC'));
    const looks = character.looks || [];
    const look = (tail && (looks.find(l => fold(l.name) === fold(tail)) || longestPrefix(looks, tail)))
      || (!tail ? looks.find(l => l.id === character.defaultLookId) || looks[0] : null);
    return {type: 'character', character, look: look || null, lookName: look ? look.name : (tail || '默认')};
  }
  return null;
}

/** Project a whole batch points at: most files whose name starts with it. */
export function batchProject(files, options) {
  const count = new Map();
  for (const f of files) { const p = longestPrefix(options.projects, stem(f.name)); if (p) count.set(p.id, (count.get(p.id) || 0) + 1); }
  let best = null, n = 0; for (const [id, c] of count) if (c > n) { best = id; n = c; }
  return validProject(options, best);
}

/**
 * Suggest one destination per file.
 * @returns {{destination: object|null, group: string, reason: string, decision?: string, hint?: string}}
 */
export function suggest(file, ctx) {
  const {options, prefs = {}, batch} = ctx, name = file.name, s = stem(name);
  const lastProject = kind => validProject(options, prefs.lastProjectId?.[kind]);
  const libDir = kind => prefs.lastLibraryDirectory?.[kind] ?? '';
  if (file.mediaKind === 'video') {
    const p = longestPrefix(options.projects, s);
    if (p) {
      const tail = rest(s, p.name.normalize('NFKC')), folders = (p.videoFolders || []).filter(f => f.id !== 'root');
      const named = tail && longestPrefix(folders, tail);
      const remembered = prefs.lastVideoFolderByProject?.[p.id];
      const folderId = named ? named.id : (remembered && (p.videoFolders || []).some(f => f.id === remembered) ? remembered : 'root');
      return {destination: {kind: 'video', scope: 'project', projectId: p.id, folderId}, group: 'video:' + p.id + ':' + folderId,
        reason: named ? '按文件名认出项目和文件夹' : folderId === 'root' ? '按文件名开头认出项目' : '按文件名开头认出项目，文件夹沿用上次'};
    }
    const last = lastProject('video');
    if (last) {
      const remembered = prefs.lastVideoFolderByProject?.[last.id];
      const folderId = remembered && (last.videoFolders || []).some(f => f.id === remembered) ? remembered : 'root';
      return {destination: {kind: 'video', scope: 'project', projectId: last.id, folderId}, group: 'video:' + last.id + ':' + folderId, reason: '沿用上次的项目和文件夹'};
    }
    const dir = libDir('video');
    return {destination: {kind: 'video', scope: 'library', directory: dir}, group: 'library:video:' + dir, reason: '没有可用的项目'};
  }
  if (file.mediaKind === 'photo') {
    // A project name at the start only counts when the remainder lands on something real.
    const own = longestPrefix(options.projects, s);
    let project = null, text = s, hint;
    if (own) {
      const tail = rest(s, own.name.normalize('NFKC'));
      if (tail && matchInProject(own, tail)) { project = own; text = tail; }
      else hint = '名字里有项目「' + own.name + '」，但没对上人物、场景或道具';
    }
    if (!project) project = batch || lastProject('photo');
    const found = project && matchInProject(project, text);
    if (found?.type === 'asset') return {destination: {kind: 'photo', scope: 'project', projectId: project.id, assetKind: found.asset.kind, assetId: found.asset.id, assetRevision: found.asset.revision},
      group: 'asset:' + project.id, reason: '按名字认出' + (found.asset.kind === 'scene' ? '场景' : '道具') + '「' + found.asset.name + '」'};
    if (found?.type === 'character') return {destination: {kind: 'photo', scope: 'project', projectId: project.id, characterName: found.character.name, lookName: found.lookName},
      group: 'character:' + project.id, reason: '按名字认出人物「' + found.character.name + '」' + (found.look ? '' : '，将新建造型「' + found.lookName + '」')};
    // An existing category is a certain match; a new character is only a guess.
    const category = longestPrefix((options.photoCategories || []).filter(c => c.id), s);
    if (category) return {destination: {kind: 'photo', scope: 'library', directory: category.id}, group: 'library:photo:' + category.id, reason: '按名字认出分类「' + category.name + '」', hint};
    const preset = imageNamePreset(text);
    if (project && preset.structured && !preset.generated && !isGenericName(text)) return {destination: {kind: 'photo', scope: 'project', projectId: project.id, characterName: preset.name, lookName: preset.lookName},
      group: 'decide', decision: 'new-character', reason: '「' + project.name + '」里还没有人物「' + preset.name + '」'};
    return {destination: {kind: 'photo', scope: 'library', directory: ''}, group: 'library:photo:', reason: '名字认不出', hint};
  }
  // Audio stays in the general music/sfx library; only the kind is preset.
  const preset = audioKindFor(file.durationSec, prefs.lastAudioKind);
  if (!preset) return {destination: null, group: 'decide', decision: 'audio-kind', reason: file.durationSec === undefined ? '正在读取时长' : '没读到时长，请选类型'};
  const dir = libDir(preset.kind);
  return {destination: {kind: preset.kind, scope: 'library', directory: dir}, group: 'library:' + preset.kind + ':' + dir, reason: formatDuration(file.durationSec) + ' · ' + preset.reason};
}

export function suggestAll(files, options, prefs) {
  const batch = batchProject(files, options);
  return Object.fromEntries(files.map(f => [f.id, suggest(f, {options, prefs, batch})]));
}
