import { createHash, randomUUID } from 'node:crypto';
export const canonical = v => JSON.stringify(v === undefined ? null : v, function (key, value) { return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value; });
export const digest = v => createHash('sha256').update(typeof v === 'string' ? v : canonical(v)).digest('hex');
export const fault = (message, status = 400, detail = {}) => Object.assign(Error(message), { status, ...detail });
export const idOK = id => typeof id === 'string' && /^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id);
export function text(value, label, max = 100000, required = false) {
  if (typeof value !== 'string' || value.length > max || /\u0000/.test(value) || required && !value.trim()) throw fault(label + '格式无效');
  return required ? value.trim() : value;
}
export const nameKey = name => digest(name.normalize('NFC').trim().toLowerCase());
export const VOICE_KEY = 'character_voice';
export const VOICE_LIMIT = 10 * 1024 * 1024;
export const VOICE_TYPES = {mp3:'audio/mpeg',wav:'audio/wav',m4a:'audio/mp4',aac:'audio/aac',ogg:'audio/ogg',flac:'audio/flac'};
export function voiceProfile(value) {
  if (value === undefined) return {version:1,description:'',clip:null};
  let p; try { p=JSON.parse(text(value,'角色语音',16000)); } catch { throw fault('角色语音资料格式无效'); }
  if (!p || p.version!==1 || typeof p.description!=='string' || Object.keys(p).some(k=>!['version','description','clip'].includes(k))) throw fault('角色语音资料格式无效');
  const description=text(p.description,'声音说明',5000), c=p.clip;
  if (c===null) return {version:1,description,clip:null};
  if (!c || Object.keys(c).sort().join(',')!=='bytes,ext,id,mime,name,sha256' || !idOK(c.id) || !Object.hasOwn(VOICE_TYPES,c.ext) || c.mime!==VOICE_TYPES[c.ext] || !/^[a-f0-9]{64}$/.test(c.sha256) || !Number.isSafeInteger(c.bytes) || c.bytes<1 || c.bytes>VOICE_LIMIT || typeof c.name!=='string' || !c.name.trim() || c.name.length>240 || /[\x00-\x1f\x7f/\\]/.test(c.name)) throw fault('角色语音文件记录无效');
  return {version:1,description,clip:{id:c.id,name:c.name,bytes:c.bytes,ext:c.ext,mime:c.mime,sha256:c.sha256}};
}
export function blankAsset(project_id, kind = 'character', name = '') {
  return { id: randomUUID(), project_id, kind, name, base_info: '', performance_info: '', details: {}, default_look_id: null, default_image_id: null, archived_at: 0, looks: [], images: [] };
}
export function normalize(input) {
  if (!input || typeof input !== 'object' || !['character', 'scene', 'prop'].includes(input.kind) || !idOK(input.project_id) || !idOK(input.id)) throw fault('资产类型、项目或编号无效');
  const a = structuredClone(input); a.name = text(a.name, '名称', 120, true); a.base_info = text(a.base_info ?? '', '基础信息'); a.performance_info = text(a.performance_info ?? '', '性格与表演');
  if (!a.details || typeof a.details !== 'object' || Array.isArray(a.details) || canonical(a.details).length > 200000) throw fault('扩展资料无效');
  if (Object.hasOwn(a.details,VOICE_KEY)) { if(a.kind!=='character')throw fault('只有人物可以添加角色语音');a.details[VOICE_KEY]=canonical(voiceProfile(a.details[VOICE_KEY])); }
  if (!Array.isArray(a.looks) || a.looks.length > 200 || !Array.isArray(a.images) || a.images.length > 1000) throw fault('造型或图片数量超出限制');
  const ids = new Set([a.id]), active = row => row.archived_at === null;
  const archive = v => { if (v !== null && (!Number.isSafeInteger(v) || v < 1)) throw fault('归档状态无效'); return v; };
  a.archived_at ??= 0;
  if (!Number.isSafeInteger(a.archived_at) || a.archived_at < 0) throw fault('归档状态无效');
  for (const [i, l] of a.looks.entries()) {
    if (!idOK(l.id) || ids.has(l.id) || a.kind !== 'character') throw fault('造型编号或归属无效'); ids.add(l.id);
    l.name = text(l.name, '造型名称', 120, true); l.description = text(l.description ?? '', '造型说明');
    if (!Array.isArray(l.tags) || l.tags.length > 30 || l.tags.some(t => typeof t !== 'string' || !t.trim() || t.length > 40)) throw fault('造型类型无效');
    l.tags = [...new Set(l.tags.map(t => t.trim()))]; l.archived_at = archive(l.archived_at ?? null); l.sort_order = i;
  }
  for (const [i, b] of a.images.entries()) {
    if (!idOK(b.id) || ids.has(b.id) || !idOK(b.media_asset_id)) throw fault('图片绑定编号无效'); ids.add(b.id);
    if (a.kind === 'character' ? !a.looks.some(l => l.id === b.look_id) : b.look_id !== null) throw fault('图片必须属于当前人物的造型或当前场景/道具');
    for (const k of ['reference_type', 'purpose', 'locks', 'ignores']) b[k] = text(b[k] ?? '', '图片职责', k === 'reference_type' ? 80 : 100000);
    b.confirmed = b.confirmed === true; b.archived_at = archive(b.archived_at ?? null); b.sort_order = i;
    b.crop ??= { x: 50, y: 50, zoom: 1 };
    if (!b.crop || !['x', 'y', 'zoom'].every(k => Number.isFinite(b.crop[k])) || b.crop.x < 0 || b.crop.x > 100 || b.crop.y < 0 || b.crop.y > 100 || b.crop.zoom < 1 || b.crop.zoom > 3) throw fault('头像裁切参数无效');
  }
  const checkDefault = (id, rows, label) => { if (rows.length ? !rows.some(r => r.id === id) : id !== null) throw fault(label + '无效；请明确选择替代项，或在没有剩余项时清空'); };
  if (a.kind === 'character') {
    checkDefault(a.default_look_id, a.looks.filter(active), '默认造型');
    if (a.default_image_id !== null) throw fault('人物代表图由默认造型确定');
    for (const l of a.looks) if (active(l)) checkDefault(l.default_image_id, a.images.filter(b => b.look_id === l.id && active(b)), '造型默认代表图');
  } else checkDefault(a.default_image_id, a.images.filter(active), '默认代表图');
  return a;
}
