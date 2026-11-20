// 项目音乐的输入校验与字段规则。谁能写什么见 SPEC 3.3：
// - 页面（用户）字段：提示词、Suno 档位、你的听感原文、版本取舍、歌曲状态、定稿；
// - AI 字段：改了什么、问题整理、客观检查、下一轮方向与提示词草稿、听感转录（只能追加原话）。
import {randomUUID} from 'node:crypto';
import {canonical, digest, fault, idOK} from '../project-assets/model.mjs';

export {canonical, digest, idOK};
export const fail = (code, message, status = 400, details) => { throw fault(message, status, {code, ...(details ? {details} : {})}); };

export const FORMATS = new Map([['.mp3', 'mp3'], ['.wav', 'wav'], ['.m4a', 'm4a'], ['.flac', 'flac']]);
export const MAX_BYTES = 200 * 1024 * 1024;
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
  if (!FORMATS.has(ext)) fail('UNSUPPORTED_FORMAT', '只支持 mp3、wav、m4a、flac 音频');
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

// 「先补上一轮」：上一轮的问题整理和下一轮方向都要有内容，才可以开新一轮。
export function roundMissing(data) {
  const missing = [];
  if (!data?.issues?.items?.length) missing.push('issues');
  if (!data?.nextDirection?.text?.trim()) missing.push('nextDirection');
  return missing;
}

export const MISSING_LABEL = {issues: '问题整理', nextDirection: '下一轮方向'};
