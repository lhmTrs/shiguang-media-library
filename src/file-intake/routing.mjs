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
// Separators people put between person, look and the rest of a name.
const PART = /[\s_\-—·.、,，:：()（）\[\]【】]+/;
const parts = text => String(text).split(PART).filter(Boolean);
/**
 * Person/look guess for a name that matches nothing yet. Any common separator counts
 * (李四-校服, 李四 校服, 李四·校服), and only the part right after the person is the look,
 * so 王五_视频3_05 guesses 王五 · 视频3 rather than a look named 视频3_05.
 */
export function guessPersonLook(text) {
  const p = parts(text), first = p[0] || '';
  const preset = imageNamePreset(p.length > 1 ? first + '_' + p[1] : String(text));
  return {...preset, lookName: preset.structured ? p[1] : preset.lookName};
}

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
    const fallback = looks.find(l => l.id === character.defaultLookId) || looks[0] || null;
    // A look is only ever an existing one: the whole tail, its start, or any later part of the
    // name that starts with a look (张大山_视频3_额伤正脸_05 → 额伤). Nothing here creates a look.
    const look = !tail ? fallback : looks.find(l => fold(l.name) === fold(tail)) || longestPrefix(looks, tail)
      || parts(tail).map(part => longestPrefix(looks, part)).find(Boolean) || null;
    return {type: 'character', character, look, lookName: look ? look.name : parts(tail)[0] || '默认', fallbackLook: fallback ? fallback.name : '默认'};
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
  const {options, prefs = {}, batch, forced} = ctx, name = file.name, s = stem(name);
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
    // The window's project bar wins over history for videos whose name names no project.
    const last = forced || lastProject('video');
    if (last) {
      const remembered = prefs.lastVideoFolderByProject?.[last.id];
      const folderId = remembered && (last.videoFolders || []).some(f => f.id === remembered) ? remembered : 'root';
      return {destination: {kind: 'video', scope: 'project', projectId: last.id, folderId}, group: 'video:' + last.id + ':' + folderId, reason: forced ? '跟随整批项目' : '沿用上次的项目和文件夹', follows: last.id};
    }
    const dir = libDir('video');
    return {destination: {kind: 'video', scope: 'library', directory: dir}, group: 'library:video:' + dir, reason: '没有可用的项目', follows: ''};
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
    // A project name whose remainder matches nothing stays a general photo with a hint:
    // it must not fall through to another project or become a new character named after the project.
    if (!project && !own) project = forced || batch || lastProject('photo');
    const r = suggestPhoto(file, options, s, project, text, hint);
    // `follows`: the project this photo was checked against without its name saying so ('' = none).
    return own ? r : {...r, follows: project ? project.id : ''};
  }
  return suggestAudio(file, prefs, libDir);
}

function suggestPhoto(file, options, s, project, text, hint) {
  const found = project && matchInProject(project, text);
  if (found?.type === 'asset') return {destination: {kind: 'photo', scope: 'project', projectId: project.id, assetKind: found.asset.kind, assetId: found.asset.id, assetRevision: found.asset.revision},
    group: 'asset:' + project.id, reason: '按名字认出' + (found.asset.kind === 'scene' ? '场景' : '道具') + '「' + found.asset.name + '」'};
  // A look the character doesn't have is asked about, like a new character: never created silently.
  if (found?.type === 'character' && !found.look) return {destination: {kind: 'photo', scope: 'project', projectId: project.id, characterName: found.character.name, lookName: found.lookName},
    group: 'decide', decision: 'new-look', reason: '「' + found.character.name + '」还没有造型「' + found.lookName + '」', fallbackLook: found.fallbackLook};
  if (found?.type === 'character') return {destination: {kind: 'photo', scope: 'project', projectId: project.id, characterName: found.character.name, lookName: found.lookName},
    group: 'character:' + project.id, reason: '按名字认出人物「' + found.character.name + '」'};
  // Agreed order: a possible new character is asked about before category matching.
  // When the name also starts with an existing category, that category is offered as the other answer.
  const category = longestPrefix((options.photoCategories || []).filter(c => c.id), s);
  const preset = guessPersonLook(text);
  if (project && preset.structured && !preset.generated && !isGenericName(text)) return {destination: {kind: 'photo', scope: 'project', projectId: project.id, characterName: preset.name, lookName: preset.lookName},
    group: 'decide', decision: 'new-character', reason: category ? '像人物，也像分类' : '项目里还没有这个人物', ...(category ? {alternative: {directory: category.id, name: category.relativePath || category.name}} : {})};
  // Library photos still carry the name-based person/look guess, so switching one to a project
  // in its 「改…」 panel starts prefilled. These fields are dropped when a library target is submitted.
  const guess = {characterName: preset.name, lookName: preset.lookName};
  if (category) return {destination: {kind: 'photo', scope: 'library', directory: category.id, ...guess}, group: 'library:photo:' + category.id, reason: '按名字认出分类「' + category.name + '」', hint};
  return {destination: {kind: 'photo', scope: 'library', directory: '', ...guess}, group: 'library:photo:', reason: '名字认不出', hint};
}

function suggestAudio(file, prefs, libDir) {
  // Audio stays in the general music/sfx library; only the kind is preset.
  const preset = audioKindFor(file.durationSec, prefs.lastAudioKind);
  if (!preset) return {destination: null, group: 'decide', decision: 'audio-kind', reason: file.durationSec === undefined ? '正在读取时长' : '没读到音频时长'};
  const dir = libDir(preset.kind);
  return {destination: {kind: preset.kind, scope: 'library', directory: dir}, group: 'library:' + preset.kind + ':' + dir, reason: formatDuration(file.durationSec) + ' · ' + preset.reason};
}

/**
 * What the project bar shows when nothing was picked. It only names a project when every file
 * the bar would steer (no project in its name) already goes by that project; otherwise it stays
 * neutral, so the user can pick any project — including the one some files already use.
 * `follows` is a project id, or '' for a file that follows no project (no history at all).
 */
export function barDefault(files, options, suggestions) {
  const ids = [...new Set(files.map(f => suggestions[f.id]?.follows).filter(v => v !== undefined))];
  if (ids.length > 1) return {projectId: null, mixed: true};
  if (ids.length === 1) return {projectId: ids[0] || null, mixed: false};
  // Nothing follows the bar (every name carries its project): show the batch's own project.
  return {projectId: batchProject(files, options)?.id || null, mixed: false};
}

/** Project the window's project bar starts on: the batch's own, else the last photo/video project. */
export function defaultProject(files, options, prefs = {}) {
  return batchProject(files, options) || validProject(options, prefs.lastProjectId?.photo) || validProject(options, prefs.lastProjectId?.video);
}

export function suggestAll(files, options, prefs, forcedProjectId) {
  const batch = batchProject(files, options), forced = validProject(options, forcedProjectId);
  return Object.fromEntries(files.map(f => [f.id, suggest(f, {options, prefs, batch, forced})]));
}
