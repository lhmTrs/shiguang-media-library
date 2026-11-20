// 项目音乐的输入校验与字段规则。谁能写什么见 SPEC 3.3：
// - 页面（用户）字段：提示词、Suno 档位、你的听感原文、版本取舍、歌曲状态、定稿；
// - AI 字段：改了什么、问题整理、客观检查、下一轮方向与提示词草稿、听感转录（只能追加原话）。
import {randomUUID} from 'node:crypto';
import {canonical, digest, fault, idOK} from '../project-assets/model.mjs';
import {isMarkerToken} from './shared/prompt-split.mjs';

export {canonical, digest, idOK};
export const fail = (code, message, status = 400, details) => { throw fault(message, status, {code, ...(details ? {details} : {})}); };

export const FORMATS = new Map([['.mp3', 'mp3'], ['.wav', 'wav'], ['.m4a', 'm4a'], ['.flac', 'flac']]);
export const MAX_BYTES = 200 * 1024 * 1024;
// 歌曲（采用和对比）只收这四种；「文件」区是存储和传递用的，收全部音频格式。
export const SONG_FORMAT_MESSAGE = '这个格式不能放进歌曲对比，请先转成 mp3/wav/m4a/flac';
export const SUNO_TIERS = {free: '免费版', pro: 'Pro', premier: 'Premier', unknown: '不确定', na: '不适用（非 Suno）'};
export const SONG_STATUS = ['active', 'final', 'abandoned'];
export const ISSUE_SOURCES = ['user_words', 'objective_check'];
export const CHECK_ITEMS = ['lyrics', 'tempo', 'duration', 'loudness', 'other'];

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export function text(value, label, max, {required = false, allowEmpty = true} = {}) {
  if (value === undefined || value === null) {
    if (required) fail('INVALID_INPUT', `请填写${label}`);
    return '';
  }
  if (typeof value !== 'string' || value.length > max || CONTROL.test(value)) fail('INVALID_INPUT', `${label}格式无效，最多 ${max} 字`);
  const trimmed = value.trim();
  if ((required || !allowEmpty) && !trimmed) fail('INVALID_INPUT', `请填写${label}`);
  return value.replace(/\r\n/g, '\n');
}

export function title(value, label = '歌名') {
  const v = text(value, label, 80, {required: true}).trim();
  if (/[\n\t]/.test(v)) fail('INVALID_INPUT', `${label}不能换行`);
  return v.normalize('NFC');
}

export function requestId(value, label = '请求编号') {
  if (!idOK(value)) fail('INVALID_REQUEST_ID', `${label}无效，请使用新的 UUID`);
  return value.toLowerCase();
}

export function revision(value, label = '版本号') {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_REVISION', `请提供${label}（expectedRevision）`);
  return value;
}

export function onlyKeys(input, allowed, code = 'INVALID_INPUT', message = '请求包含不支持的字段', status = 400) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT', '请求体必须是 JSON 对象');
  const extra = Object.keys(input).filter(k => !allowed.includes(k));
  if (extra.length) fail(code, `${message}：${extra.join('、')}`, status, {fields: extra});
  return input;
}

export function fileName(value) {
  const name = text(value, '文件名', 240, {required: true}).normalize('NFC');
  if (/^[. ]|[<>:"/\\|?*\u0000-\u001f]|[. ]$/.test(name)) fail('INVALID_FILE', '文件名无效');
  const ext = (name.match(/\.[^.]+$/)?.[0] || '').toLowerCase();
  if (!FORMATS.has(ext)) fail('UNSUPPORTED_FORMAT', SONG_FORMAT_MESSAGE);
  return {name, ext};
}

export function label(value) {
  const v = text(value, '版本标签', 40, {required: true}).trim().normalize('NFC');
  if (/[<>:"/\\|?*\n\t]/.test(v) || /^[. ]|[. ]$/.test(v)) fail('INVALID_INPUT', '版本标签不能含 / \\ : * ? " < > | 或首尾的点');
  return v;
}

export function now() { return Date.now(); }
export function newId() { return randomUUID(); }

// 页面作者与 AI 作者。AI 每一段都要带会话名和服务端时间（SPEC 3.3 末条）。
export const userAuthor = () => ({kind: 'user', at: now()});
export function agentAuthor(session) {
  const s = text(session, '会话名（session）', 120, {required: true}).trim();
  if (/\n/.test(s)) fail('INVALID_INPUT', '会话名不能换行');
  return {kind: 'agent', session: s, at: now()};
}

export function prompt(input = {}, previous = null) {
  onlyKeys(input, ['tool', 'style', 'lyrics', 'params', 'sunoLink', 'sunoTier'], 'INVALID_INPUT', '提示词包含不支持的字段');
  const tier = input.sunoTier ?? previous?.sunoTier ?? '';
  if (tier !== '' && !Object.hasOwn(SUNO_TIERS, tier)) fail('INVALID_INPUT', 'Suno 会员档位无效；不确定请选「不确定」');
  return {
    tool: text(input.tool ?? previous?.tool ?? 'Suno', '生成工具', 80).trim() || 'Suno',
    style: text(input.style ?? '', '风格', 4000),
    lyrics: text(input.lyrics ?? '', '歌词', 20000),
    params: text(input.params ?? '', '其他参数', 4000),
    sunoLink: text(input.sunoLink ?? '', 'Suno 链接或编号', 500).trim(),
    sunoTier: tier,
  };
}

export function issues(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.items) || input.items.length > 40) fail('INVALID_INPUT', '问题整理需要 items 数组（最多 40 条）');
  onlyKeys(input, ['items']);
  return {items: input.items.map((item, i) => {
    onlyKeys(item, ['text', 'source', 'causeGuess'], 'INVALID_INPUT', `第 ${i + 1} 条问题含不支持的字段`);
    if (!ISSUE_SOURCES.includes(item.source)) fail('ISSUE_SOURCE_REQUIRED', `第 ${i + 1} 条问题必须标明来源：user_words（来自你的原话）或 objective_check（来自客观检查）`);
    return {
      text: text(item.text, `第 ${i + 1} 条问题`, 2000, {required: true}).trim(),
      source: item.source,
      causeGuess: text(item.causeGuess ?? '', `第 ${i + 1} 条的原因猜测`, 2000).trim(),
    };
  })};
}

export function checks(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.items) || input.items.length > 40) fail('INVALID_INPUT', '客观检查需要 items 数组（最多 40 条）');
  onlyKeys(input, ['items']);
  return {items: input.items.map((item, i) => {
    onlyKeys(item, ['item', 'versionId', 'result', 'method'], 'INVALID_INPUT', `第 ${i + 1} 项检查含不支持的字段`);
    if (!CHECK_ITEMS.includes(item.item)) fail('INVALID_INPUT', `第 ${i + 1} 项检查类型应为 ${CHECK_ITEMS.join('/')}`);
    if (item.versionId != null && !idOK(item.versionId)) fail('INVALID_INPUT', `第 ${i + 1} 项检查的 versionId 无效`);
    return {
      item: item.item,
      versionId: item.versionId ? item.versionId.toLowerCase() : null,
      result: text(item.result, `第 ${i + 1} 项检查结果`, 4000, {required: true}).trim(),
      method: text(item.method, `第 ${i + 1} 项检查方法`, 1000, {required: true}).trim(),
    };
  })};
}

export function nextDirection(input) {
  if (!input || typeof input !== 'object') fail('INVALID_INPUT', '下一轮方向需要对象 {text, promptDraft?}');
  onlyKeys(input, ['text', 'promptDraft']);
  let draft = null;
  if (input.promptDraft != null) {
    onlyKeys(input.promptDraft, ['style', 'lyrics', 'params'], 'INVALID_INPUT', '提示词草稿只接受 style、lyrics、params');
    draft = {
      style: text(input.promptDraft.style ?? '', '草稿风格', 4000),
      lyrics: text(input.promptDraft.lyrics ?? '', '草稿歌词', 20000),
      params: text(input.promptDraft.params ?? '', '草稿参数', 4000),
    };
  }
  return {text: text(input.text, '下一轮方向', 4000, {required: true}).trim(), promptDraft: draft};
}

export function changes(input) {
  if (!input || typeof input !== 'object') fail('INVALID_INPUT', '「改了什么」需要对象 {text, count?}');
  onlyKeys(input, ['text', 'count']);
  if (input.count != null && (!Number.isSafeInteger(input.count) || input.count < 0 || input.count > 100)) fail('INVALID_INPUT', 'count 为改动处数（0–100）');
  return {text: text(input.text, '改了什么', 4000, {required: true}).trim(), count: input.count ?? null};
}

// 「先补上一轮」：上一轮的问题整理和下一轮方向都不为空，才可以开新一轮。
// AI 写的条目或你自己写的一句话，任一有内容就算填了，不要求条目格式（SPEC 第十节）。
export function roundMissing(data) {
  const missing = [];
  if (!data?.issues?.items?.length && !data?.userIssues?.text?.trim()) missing.push('issues');
  if (!data?.nextDirection?.text?.trim() && !data?.userDirection?.text?.trim()) missing.push('nextDirection');
  return missing;
}

// 你自己写的问题整理、下一轮方向：一段文字即可，作者记为「你」，和 AI 写的分开存放和显示。
export function userNote(value, label) {
  if (value === null) return null;
  const body = text(value, label, 4000).trim();
  return body ? body : null;
}

// 原话时间：北京时间，格式 YYYY-MM-DD HH:mm，与页面上其他时间一致。
export function saidAt(value) {
  const v = text(value ?? '', '原话时间', 16).trim();
  if (v && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(v)) fail('INVALID_INPUT', '原话时间请写北京时间，格式 YYYY-MM-DD HH:mm；查不到就不写');
  return v;
}

export const MISSING_LABEL = {issues: '问题整理', nextDirection: '下一轮方向'};

// ---------- 对比（SPEC 3.4）：只能由用户记录；可以只写一句话，不强制按段落填 ----------
const SIDES = ['left', 'right', 'same'];
export function comparison(input) {
  onlyKeys(input, ['requestId', 'leftVersionId', 'rightVersionId', 'blind', 'markers', 'segments', 'summary', 'winner', 'loudness']);
  const left = String(input.leftVersionId ?? '').toLowerCase(), right = String(input.rightVersionId ?? '').toLowerCase();
  if (!idOK(left) || !idOK(right)) fail('INVALID_INPUT', '请选择两个要对比的版本');
  if (left === right) fail('INVALID_INPUT', '请选择两个不同的版本');
  if (typeof (input.blind ?? false) !== 'boolean') fail('INVALID_INPUT', 'blind 应为 true 或 false');
  const markers = input.markers ?? [];
  if (!Array.isArray(markers) || markers.length > 50) fail('INVALID_INPUT', '段落标记最多 50 个');
  const segments = input.segments ?? [];
  if (!Array.isArray(segments) || segments.length > 30) fail('INVALID_INPUT', '段落结果最多 30 条');
  if (input.winner != null && !SIDES.includes(input.winner)) fail('INVALID_INPUT', '整体结果只能是 left、right 或 same');
  const out = {
    leftVersionId: left, rightVersionId: right, blind: input.blind === true,
    markers: markers.map((m, i) => {
      onlyKeys(m, ['label', 'ms'], 'INVALID_INPUT', `第 ${i + 1} 个标记含不支持的字段`);
      if (!Number.isSafeInteger(m.ms) || m.ms < 0 || m.ms > 86400000) fail('INVALID_INPUT', `第 ${i + 1} 个标记的时间无效`);
      return {label: text(m.label ?? '', `第 ${i + 1} 个标记名`, 40).trim() || `标记 ${i + 1}`, ms: m.ms};
    }).sort((a, b) => a.ms - b.ms),
    segments: segments.map((s, i) => {
      onlyKeys(s, ['label', 'winner', 'note'], 'INVALID_INPUT', `第 ${i + 1} 条段落结果含不支持的字段`);
      if (!SIDES.includes(s.winner)) fail('INVALID_INPUT', `第 ${i + 1} 条段落结果请选哪一版更好，或差不多`);
      return {label: text(s.label, `第 ${i + 1} 条段落名`, 40, {required: true}).trim(), winner: s.winner, note: text(s.note ?? '', `第 ${i + 1} 条备注`, 500).trim()};
    }),
    summary: text(input.summary ?? '', '对比结果', 2000).trim(),
    winner: input.winner ?? null,
    loudness: null,
  };
  if (input.loudness != null) {
    onlyKeys(input.loudness, ['matched', 'gainDb'], 'INVALID_INPUT', 'loudness 只接受 matched 与 gainDb');
    if (typeof input.loudness.matched !== 'boolean' || typeof input.loudness.gainDb !== 'number' || !Number.isFinite(input.loudness.gainDb) || Math.abs(input.loudness.gainDb) > 60) fail('INVALID_INPUT', '响度对齐信息无效');
    out.loudness = {matched: input.loudness.matched, gainDb: Math.round(input.loudness.gainDb * 10) / 10};
  }
  if (!out.summary && !out.segments.length && !out.winner) fail('COMPARISON_EMPTY', '写一句结果，或选出哪一版更好，再保存');
  return out;
}

// AI 提供的歌词每句时间：按版本分别给，对比页点某句歌词时两版各跳到自己的那一句。
export function lyricTimes(input) {
  if (!Array.isArray(input) || !input.length || input.length > 20) fail('INVALID_INPUT', 'lyricTimes 需要 1–20 个版本');
  return input.map((v, i) => {
    onlyKeys(v, ['versionId', 'lines', 'method'], 'INVALID_INPUT', `lyricTimes 第 ${i + 1} 项含不支持的字段`);
    if (!idOK(v.versionId)) fail('INVALID_INPUT', `lyricTimes 第 ${i + 1} 项的 versionId 无效`);
    if (!Array.isArray(v.lines) || !v.lines.length || v.lines.length > 300) fail('INVALID_INPUT', '每个版本 1–300 句');
    let prev = -1;
    const lines = v.lines.map((l, j) => {
      onlyKeys(l, ['text', 'startMs'], 'INVALID_INPUT', `第 ${j + 1} 句含不支持的字段`);
      if (!Number.isSafeInteger(l.startMs) || l.startMs < 0 || l.startMs > 86400000 || l.startMs < prev) fail('INVALID_INPUT', `第 ${j + 1} 句的 startMs 无效或早于上一句`);
      prev = l.startMs;
      return {text: text(l.text, `第 ${j + 1} 句歌词`, 300, {required: true}).trim(), startMs: l.startMs};
    });
    return {versionId: v.versionId.toLowerCase(), lines, method: text(v.method, '歌词时间的得出方法', 500, {required: true}).trim()};
  });
}

// ---------- PR3：音乐库标签（SPEC 第十一节第 4 条） ----------
// 每条标签都记来源：system（系统写的项目、歌名、轮次、AI生成）、prompt（按提示词）、measured（测量）、status（未选用）。
// 写进音乐库时沿用批量标注接口的 basis：测量的记 listened，其余记 metadata。
export const LIBRARY_ROOT_NAME = 'AI生成';
export const TAG_MAX = 60;
const clip = (s, max = TAG_MAX) => [...String(s).normalize('NFC').trim()].slice(0, max).join('').trim();

// 从风格字段拆标签：按逗号、顿号、斜杠、分号、空白分。只拆，不改写，不推断。带方括号的段落标记（[Verse] 之类）一律不当标签。
export function promptTags(style) {
  const out = [];
  for (const part of String(style ?? '').split(/[,，、/／;；\s]+/u)) {
    const t = clip(part.replace(/^[#＃]+/u, ''));
    if (t && !isMarkerToken(t) && !/[\r\n\t]/.test(t) && !out.some(x => x.toLowerCase() === t.toLowerCase())) out.push(t);
    if (out.length >= 16) break;
  }
  return out;
}

export const unusedTag = projectName => clip(`未选用（${clip(projectName, TAG_MAX - 5)}）`);
export const roundTag = n => `第${n}轮`;
export const clipTag = clip;

// AI 测量的结果：写在版本上，标签由服务端按固定格式生成（「120 BPM」「时长 3:12」「有人声」「纯音乐」「中文」）。
const VOCALS = {vocal: '有人声', instrumental: '纯音乐'};
export function measurements(input) {
  if (!Array.isArray(input) || !input.length || input.length > 20) fail('INVALID_INPUT', 'measurements 需要 1–20 个版本');
  return input.map((m, i) => {
    onlyKeys(m, ['versionId', 'bpm', 'durationMs', 'vocals', 'language', 'method'], 'INVALID_INPUT', `measurements 第 ${i + 1} 项含不支持的字段`);
    if (!idOK(m.versionId)) fail('INVALID_INPUT', `measurements 第 ${i + 1} 项的 versionId 无效`);
    if (m.bpm != null && (typeof m.bpm !== 'number' || !Number.isFinite(m.bpm) || m.bpm < 20 || m.bpm > 400)) fail('INVALID_INPUT', `第 ${i + 1} 项 bpm 应在 20–400`);
    if (m.durationMs != null && (!Number.isSafeInteger(m.durationMs) || m.durationMs < 1 || m.durationMs > 86400000)) fail('INVALID_INPUT', `第 ${i + 1} 项 durationMs 无效`);
    if (m.vocals != null && !Object.hasOwn(VOCALS, m.vocals)) fail('INVALID_INPUT', `第 ${i + 1} 项 vocals 只能是 vocal 或 instrumental`);
    const language = m.language == null ? null : clip(text(m.language, '语种', 20, {required: true}), 20);
    const out = {versionId: m.versionId.toLowerCase(), bpm: m.bpm == null ? null : Math.round(m.bpm), durationMs: m.durationMs ?? null, vocals: m.vocals ?? null, language,
      method: text(m.method, '测量方法', 500, {required: true}).trim()};
    if (out.bpm == null && out.durationMs == null && !out.vocals && !out.language) fail('INVALID_INPUT', `第 ${i + 1} 项没有任何测量结果`);
    return out;
  });
}
export function measuredTags(m) {
  if (!m) return [];
  const tags = [];
  if (m.bpm != null) tags.push(`${m.bpm} BPM`);
  if (m.durationMs != null) { const s = Math.round(m.durationMs / 1000); tags.push(`时长 ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`); }
  if (m.vocals) tags.push(VOCALS[m.vocals]);
  if (m.language) tags.push(m.language);
  return tags;
}

// ---------- PR3：AI 按用户原话改版本状态（第十一节末「开发统筹按试行规矩定了」） ----------
export const DECISION_ACTIONS = {reject: '淘汰', restore: '恢复为候选', best: '设为当前最好', final: '定稿'};
export function decisions(input) {
  if (!Array.isArray(input) || !input.length || input.length > 10) fail('INVALID_INPUT', 'decisions 需要 1–10 条');
  return input.map((d, i) => {
    onlyKeys(d, ['versionId', 'action', 'userWords', 'saidAt'], 'INVALID_INPUT', `decisions 第 ${i + 1} 条含不支持的字段`);
    if (!idOK(d.versionId)) fail('INVALID_INPUT', `decisions 第 ${i + 1} 条的 versionId 无效`);
    if (!Object.hasOwn(DECISION_ACTIONS, d.action)) fail('INVALID_INPUT', `decisions 第 ${i + 1} 条的 action 只能是 ${Object.keys(DECISION_ACTIONS).join('、')}`);
    const words = text(d.userWords ?? '', `第 ${i + 1} 条的用户原话`, 1000).trim();
    if (!words) fail('USER_WORDS_REQUIRED', 'AI 改版本状态必须附上用户在对话里说的原话（userWords），一字不改', 400);
    return {versionId: d.versionId.toLowerCase(), action: d.action, userWords: words, saidAt: saidAt(d.saidAt)};
  });
}
