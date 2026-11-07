import { validateSchema } from './schema-validator.mjs';
// File-format functions run identically in Node and the browser. No filesystem or AI calls.
export const SCHEMA_VERSION = '1.0.0';
export const TEMPLATE_VERSION = 'integrated-video-1.0.0';
export const clone = value => structuredClone(value);
export const uid = prefix => prefix + '_' + crypto.randomUUID();
export const canonical = value => JSON.stringify(value, (_key, row) => row && typeof row === 'object' && !Array.isArray(row) ? Object.fromEntries(Object.keys(row).sort().map(k => [k, row[k]])) : row);
export const pretty = value => JSON.stringify(value, null, 2);
export function secondsToMs(value) { const s = String(value).trim(); if (!/^\d+(?:\.\d{1,3})?$/.test(s))
    throw Error('时长须为非负数，最多三位小数'); const [a, b = ''] = s.split('.'); const n = Number(a) * 1000 + Number(b.padEnd(3, '0')); if (!Number.isSafeInteger(n) || n <= 0 || n > 86400000)
    throw Error('单镜时长须大于 0 且不超过 24 小时'); return n; }
export const sec = ms => Number((ms / 1000).toFixed(3)).toString();
export function clock(ms) { return String(Math.floor(ms / 60000)).padStart(2, '0') + ':' + (ms % 60000 / 1000).toFixed(3).padStart(6, '0').replace(/\.000$/, ''); }
export function timeline(project) { let cursor = 0, index = 0; return project.scenes.flatMap((scene, sceneIndex) => scene.shots.map(shot => { const start_ms = cursor; cursor += shot.duration_ms; return { shot, scene, sceneIndex, number: String(++index).padStart(2, '0'), start_ms, end_ms: cursor }; })); }
export const duration = project => timeline(project).at(-1)?.end_ms ?? 0;
export const dialogueCount = project => project.scenes.reduce((n, s) => n + s.shots.reduce((m, q) => m + q.dialogue.length, 0), 0);
export function emptyShot() { return { id: uid('shot'), revision: 1, duration_ms: 3000, framing: '', action: '', camera: '', sound: '', transition: '', character_ids: [], character_presence: [], reference_bindings: [], dialogue: [], audio_continuations: [], continuity: '', design_note: '', first_frame: '', physical_feedback: '', environment_feedback: '', result: '', extensions: {} }; }
export function emptyProject() { return { schema_version: SCHEMA_VERSION, project_id: uid('project'), revision: 1, title: '未命名分镜', synopsis: '', settings: { aspect_ratio: '16:9', fps: 30, target_duration_ms: 80000, platform: '待选择', model: '待选择' }, characters: [], assets: [], global_rules: {}, scenes: [{ id: uid('scene'), name: '第一场', location: '', story_time: '', interior_exterior: '', spatial_setup: '', shots: [emptyShot()] }], reference_bindings: [], generation_batches: [], generation_runs: [], extensions: {} }; }
const error = (path, message) => ({ path, message });
export function validateProject(p) {
    const errors = validateSchema(p);
    const add = (path, message) => errors.push(error(path, message));
    const obj = v => v && typeof v === 'object' && !Array.isArray(v);
    if (!obj(p))
        return [error('$', '项目必须是 JSON 对象')];
    const allIds = new Set(), id = (v, path) => { if (typeof v !== 'string' || !v.trim() || v.length > 160)
        add(path, 'ID 须为 1—160 字符');
    else if (allIds.has(v))
        add(path, '重复 ID：' + v);
    else
        allIds.add(v); };
    const str = (v, path) => { if (typeof v !== 'string')
        add(path, '须为字符串'); };
    const arr = (v, path) => { if (!Array.isArray(v)) {
        add(path, '须为数组');
        return [];
    } return v; };
    const positive = (v, path) => { if (!Number.isSafeInteger(v) || v < 1)
        add(path, '须为正整数'); };
    if (p.schema_version !== SCHEMA_VERSION)
        add('schema_version', '不支持的格式版本：' + String(p.schema_version));
    id(p.project_id, 'project_id');
    if (typeof p.project_id === 'string' && !/^[a-zA-Z0-9_-]{1,160}$/.test(p.project_id))
        add('project_id', '仅支持英文字母、数字、下划线、短横线');
    positive(p.revision, 'revision');
    str(p.title, 'title');
    str(p.synopsis, 'synopsis');
    if (!obj(p.settings))
        add('settings', '缺少项目设置');
    else {
        str(p.settings.aspect_ratio, 'settings.aspect_ratio');
        positive(p.settings.fps, 'settings.fps');
        positive(p.settings.target_duration_ms, 'settings.target_duration_ms');
    }
    if (!obj(p.global_rules))
        add('global_rules', '须为对象');
    const chars = new Set(), assets = new Set(), scenes = new Set(), shots = new Map(), dialogues = new Map(), batches = new Set();
    arr(p.characters, 'characters').forEach((c, i) => { const at = `characters[${i}]`; if (!obj(c)) {
        add(at, '须为人物对象');
        return;
    } id(c.id, at + '.id'); chars.add(c.id); str(c.name, at + '.name'); if (typeof c.name === 'string' && !c.name.trim())
        add(at + '.name', '人物姓名不能为空'); });
    arr(p.assets, 'assets').forEach((a, i) => { const at = `assets[${i}]`; if (!obj(a)) {
        add(at, '须为素材对象');
        return;
    } id(a.id, at + '.id'); assets.add(a.id); str(a.path, at + '.path'); str(a.media_type, at + '.media_type'); if (typeof a.path === 'string' && (/^(?:[a-z]+:|[\\/])/i.test(a.path) || a.path.split(/[\\/]/).includes('..')))
        add(at + '.path', '素材路径须为项目内相对路径'); if (a.embedded_data !== undefined && (typeof a.embedded_data !== 'string' || !/^data:(image\/(?:png|jpeg|webp|gif)|video\/(?:mp4|webm)|audio\/(?:mpeg|wav|ogg));base64,[A-Za-z0-9+/=]+$/.test(a.embedded_data)))
        add(at + '.embedded_data', '仅支持图片、视频或音频的 base64 内嵌数据'); });
    arr(p.scenes, 'scenes').forEach((s, i) => {
        const at = `scenes[${i}]`;
        if (!obj(s)) {
            add(at, '须为场景对象');
            return;
        }
        id(s.id, at + '.id');
        scenes.add(s.id);
        for (const k of ['location', 'story_time', 'interior_exterior', 'spatial_setup'])
            str(s[k], at + '.' + k);
        arr(s.shots, at + '.shots').forEach((q, j) => {
            const t = `${at}.shots[${j}]`;
            if (!obj(q)) {
                add(t, '须为镜头对象');
                return;
            }
            id(q.id, t + '.id');
            shots.set(q.id, q);
            positive(q.revision, t + '.revision');
            if (!Number.isSafeInteger(q.duration_ms) || q.duration_ms <= 0 || q.duration_ms > 86400000)
                add(t + '.duration_ms', '须为 1—86400000 的整数毫秒');
            for (const k of ['framing', 'action', 'camera', 'sound', 'transition'])
                str(q[k], t + '.' + k);
            arr(q.character_ids, t + '.character_ids');
            arr(q.reference_bindings, t + '.reference_bindings');
            arr(q.audio_continuations, t + '.audio_continuations');
            arr(q.dialogue, t + '.dialogue').forEach((d, k) => { const a = `${t}.dialogue[${k}]`; if (!obj(d)) {
                add(a, '须为对白对象');
                return;
            } id(d.id, a + '.id'); dialogues.set(d.id, { shot_id: q.id, ...d }); for (const key of ['text', 'source', 'performance'])
                str(d[key], a + '.' + key); if (!chars.has(d.character_id))
                add(a + '.character_id', '引用的人物不存在'); });
        });
    });
    const binding = (b, path) => { if (!obj(b)) {
        add(path, '须为参考绑定对象');
        return;
    } if (!assets.has(b.asset_id))
        add(path + '.asset_id', '引用的素材不存在'); if (b.subject_id && !chars.has(b.subject_id) && !scenes.has(b.subject_id))
        add(path + '.subject_id', '引用的人物或场景不存在'); for (const [key, set] of [['scene_ids', scenes], ['shot_ids', new Set(shots.keys())]])
        if (b[key] !== undefined)
            arr(b[key], path + '.' + key).forEach(v => { if (!set.has(v))
                add(path + '.' + key, '引用不存在：' + v); }); for (const key of ['locks', 'ignores'])
        if (typeof b[key] !== 'string')
            add(path + '.' + key, '须填写文本（可为空）'); };
    arr(p.reference_bindings ?? [], 'reference_bindings').forEach((b, i) => binding(b, `reference_bindings[${i}]`));
    arr(p.scenes, 'scenes').forEach((s, i) => { if (!obj(s))
        return; (Array.isArray(s.shots) ? s.shots : []).forEach((q, j) => { if (!obj(q))
        return; const t = `scenes[${i}].shots[${j}]`; if (Array.isArray(q.character_ids))
        q.character_ids.forEach(v => { if (!chars.has(v))
            add(t + '.character_ids', '引用的人物不存在：' + v); }); if (q.character_presence !== undefined)
        arr(q.character_presence, t + '.character_presence').forEach((v, k) => { if (!chars.has(v?.character_id))
            add(t + `.character_presence[${k}]`, '引用的人物不存在'); if (!['visible', 'offscreen', 'voice_only', 'unspecified'].includes(v?.mode))
            add(t + `.character_presence[${k}].mode`, '出场方式无效'); }); if (Array.isArray(q.reference_bindings))
        q.reference_bindings.forEach((b, k) => binding(b, t + `.reference_bindings[${k}]`)); if (Array.isArray(q.audio_continuations))
        q.audio_continuations.forEach((c, k) => { const a = t + `.audio_continuations[${k}]`; if (!obj(c)) {
            add(a, '须为承接对象');
            return;
        } const d = dialogues.get(c.dialogue_id); if (!shots.has(c.source_shot_id))
            add(a + '.source_shot_id', '来源镜头不存在'); if (!d || d.shot_id !== c.source_shot_id)
            add(a + '.dialogue_id', '来源对白不存在或不属于来源镜头'); }); }); });
    arr(p.generation_batches, 'generation_batches').forEach((b, i) => { const at = `generation_batches[${i}]`; if (!obj(b)) {
        add(at, '须为批次对象');
        return;
    } id(b.id, at + '.id'); batches.add(b.id); arr(b.shot_ids, at + '.shot_ids'); if (!obj(b.input_snapshot))
        add(at + '.input_snapshot', '须保留输入快照'); if (typeof b.prompt !== 'string')
        add(at + '.prompt', '须保留提示词全文'); if (typeof b.input_hash !== 'string')
        add(at + '.input_hash', '须保留输入哈希'); });
    arr(p.generation_runs, 'generation_runs').forEach((v, i) => { const at = `generation_runs[${i}]`; if (!obj(v)) {
        add(at, '须为任务对象');
        return;
    } id(v.id, at + '.id'); if (!batches.has(v.batch_id))
        add(at + '.batch_id', '生成批次不存在'); if (!['draft', 'submitting', 'pending', 'succeeded', 'failed', 'unknown'].includes(v.status))
        add(at + '.status', '任务状态无效'); });
    if (p.asset_manifest !== undefined) {
        const manifest = p.asset_manifest, sets = {};
        if (!obj(manifest)) add('asset_manifest', '须为对象');
        else {
            for (const kind of ['character','scene','prop']) {
                sets[kind] = new Set();
                arr(manifest[kind], 'asset_manifest.' + kind).forEach((v,i) => { if (!obj(v) || typeof v.id !== 'string' || !v.id || typeof v.name !== 'string' || !v.name.trim()) add('asset_manifest.'+kind+'['+i+']', '清单条目须有编号和名称'); else { if (sets[kind].has(v.id)) add('asset_manifest.'+kind, '清单编号重复'); sets[kind].add(v.id); } });
            }
            if (canonical([...chars].sort()) !== canonical([...sets.character].sort())) add('asset_manifest.character', '人物清单与人物档案编号不一致');
            for (const [i,s] of (Array.isArray(p.scenes) ? p.scenes : []).entries()) {
                if (!obj(s)) continue;
                if (s.scene_asset_id && !sets.scene.has(s.scene_asset_id)) add(`scenes[${i}].scene_asset_id`, '引用的场景不在清单中');
                for (const [j,q] of (Array.isArray(s.shots) ? s.shots : []).entries()) {
                    if (!obj(q)) continue;
                    if (q.scene_asset_id && !sets.scene.has(q.scene_asset_id)) add(`scenes[${i}].shots[${j}].scene_asset_id`, '引用的场景不在清单中');
                    for (const v of Array.isArray(q.prop_ids) ? q.prop_ids : []) if (!sets.prop.has(v)) add(`scenes[${i}].shots[${j}].prop_ids`, '引用的道具不在清单中');
                }
            }
        }
    }
    return errors;
}
export function normalizeProject(value) { const p = clone(value); p.reference_bindings ??= []; for (const s of p.scenes)
    for (const q of s.shots) {
        q.character_presence ??= [];
        for (const k of ['continuity', 'design_note', 'first_frame', 'physical_feedback', 'environment_feedback', 'result'])
            q[k] ??= '';
    } return p; }
export function importProject(value, { filename = '导入.json', timing = 'duration' } = {}) {
    if (!value || typeof value !== 'object')
        return { project: null, errors: [error('$', '须为 JSON 对象')], warnings: [] };
    if (value.schema_version) {
        const errors = validateProject(value);
        if (errors.length)
            return { project: clone(value), errors, warnings: [] };
        const p = normalizeProject(value);
        return { project: p, errors: [], warnings: [] };
    }
    if (!Array.isArray(value['场景']) || !Array.isArray(value['人物']))
        return { project: null, errors: [error('$', '未识别的格式：需要规范化项目或包含“场景”和“人物”的中文 JSON')], warnings: [] };
    const warnings = [], p = emptyProject();
    p.title = value['项目名称'] ?? '导入分镜';
    p.synopsis = value['故事核心'] ?? '';
    p.settings.aspect_ratio = value['画幅'] ?? '16:9';
    p.settings.target_duration_ms = Math.round(Number(value['总时长秒'] ?? 80) * 1000);
    p.metadata = { type: value['类型'] ?? '', format: value['形式'] ?? '', timeline_description: value['时间轴说明'] ?? '' };
    p.global_rules = { film_settings: clone(value['全片设定'] ?? {}), continuity: clone(value['连续性与时长锁定'] ?? {}), format: value['形式'] ?? '' };
    p.import_source = { filename, source_version: value['版本'] ?? '', original: clone(value), timing_basis: timing };
    p.characters = value['人物'].map(c => ({ id: uid('character'), name: c['姓名'], age: c['年龄'] ?? '', role: c['身份'] ?? '', description: c['人物特点'] ?? '', source: clone(c) }));
    const names = new Map(p.characters.map(c => [c.name, c.id]));
    const shotNumbers = new Map();
    p.scenes = value['场景'].map((s, i) => ({ id: uid('scene'), name: `第${s['场次'] ?? i + 1}场 · ${s['地点'] ?? ''}`, location: s['地点'] ?? '', story_time: s['时间'] ?? '', interior_exterior: s['内外景'] ?? '', spatial_setup: s['空间设定'] ?? '', source: clone(Object.fromEntries(Object.entries(s).filter(([k]) => k !== '镜头'))), shots: (s['镜头'] ?? []).map(q => { let duration_ms; try {
            duration_ms = secondsToMs(timing === 'range' ? Number((Number(q['结束秒']) - Number(q['开始秒'])).toFixed(3)) : q['时长秒']);
        }
        catch (e) {
            duration_ms = 0;
            warnings.push({ path: '镜' + q['镜号'], message: e.message });
        } const shot = { ...emptyShot(), duration_ms, framing: q['景别与角度'] ?? '', action: q['画面与人物动作'] ?? '', camera: q['摄影机设计'] ?? '', sound: q['声音与对白']?.['环境与动作声'] ?? '', transition: q['剪辑衔接'] ?? '', source: clone(q), dialogue: (q['声音与对白']?.['对白'] ?? []).map(d => ({ id: uid('dialogue'), character_id: names.get(d['人物']) ?? '', source: d['声源'] ?? '', text: d['台词'] ?? '', performance: d['表演要求'] ?? '', import_source: clone(d) })) }; shot.character_ids = [...new Set(shot.dialogue.map(d => d.character_id).filter(Boolean))]; shot.character_presence = shot.character_ids.map(id => ({ character_id: id, mode: shot.dialogue.filter(d => d.character_id === id).every(d => /电话|语音|画外/.test(d.source)) ? 'voice_only' : 'unspecified' })); shotNumbers.set(String(q['镜号']).padStart(2, '0'), shot); return shot; }) }));
    for (const scene of p.scenes)
        for (const q of scene.shots) {
            const continuation = q.source['声音与对白']?.['承接对白'];
            if (continuation) {
                const from = shotNumbers.get(String(continuation['来源镜号']).padStart(2, '0'));
                q.audio_continuations = [{ source_shot_id: from?.id ?? '', dialogue_id: from?.dialogue.at(-1)?.id ?? '', note: continuation['说明'] ?? '', import_source: clone(continuation) }];
            }
        }
    const rawTimes = [];
    let t = 0;
    for (const [i, s] of value['场景'].entries()) {
        let sceneDuration = 0;
        const sceneStart = t;
        for (const q of s['镜头'] ?? []) {
            const ms = Math.round(Number(q['时长秒']) * 1000), range = Math.round((Number(q['结束秒']) - Number(q['开始秒'])) * 1000);
            if (ms !== range || Math.round(Number(q['开始秒']) * 1000) !== t)
                rawTimes.push({ path: `场景[${i}] 镜${q['镜号']}`, message: `原时长 ${q['时长秒']} 秒，原范围 ${q['开始秒']}—${q['结束秒']} 秒，累计起点 ${sec(t)} 秒`, kind: 'timing' });
            t += ms;
            sceneDuration += ms;
        }
        if (sceneStart !== Math.round(Number(s['开始秒']) * 1000) || t !== Math.round(Number(s['结束秒']) * 1000))
            rawTimes.push({ path: `场景[${i}]`, message: '场景起止范围与镜头累计时间不一致', kind: 'timing' });
        if (sceneDuration !== Math.round(Number(s['时长秒']) * 1000))
            rawTimes.push({ path: `场景[${i}]`, message: '场次汇总与镜头时长不一致', kind: 'timing' });
    }
    if (t !== p.settings.target_duration_ms)
        rawTimes.push({ path: '总时长秒', message: `镜头合计 ${sec(t)} 秒，目标 ${sec(p.settings.target_duration_ms)} 秒`, kind: 'timing' });
    warnings.push(...rawTimes);
    warnings.push({ path: '人物出场方式', message: '仅从明确对白建立关联；画内人物、造型与参考职责保留原文，需人工确认，未推断成事实。' });
    warnings.push({ path: 'import_source.original', message: '已保留完整原文件；未知字段保存在来源数据，标准导出会一并保留。' });
    return { project: p, errors: validateProject(p), warnings };
}
export function commitProject(before, recipe) { const next = clone(before); recipe(next); if (canonical(next) === canonical(before))
    return before; next.revision = before.revision + 1; const old = new Map(timeline(before).map(r => [r.shot.id, r.shot])); for (const { shot } of timeline(next)) {
    const was = old.get(shot.id);
    if (was && canonical({ ...was, revision: 0 }) !== canonical({ ...shot, revision: 0 }))
        shot.revision = was.revision + 1;
} return next; }
export function restoreHistory(current, snapshot) { const next = clone(snapshot); next.revision = current.revision + 1; const old = new Map(timeline(current).map(r => [r.shot.id, r.shot])); for (const { shot } of timeline(next)) {
    const was = old.get(shot.id);
    shot.revision = Math.max(shot.revision, was?.revision ?? 0) + (was && canonical({ ...was, revision: 0 }) !== canonical({ ...shot, revision: 0 }) ? 1 : 0);
} return next; }
export function moveShot(p, id, targetSceneId, beforeId = null) { if (id === beforeId)
    return; if (!p.scenes.some(s => s.id === targetSceneId))
    throw Error('目标场景不存在'); let shot; for (const s of p.scenes) {
    const i = s.shots.findIndex(q => q.id === id);
    if (i >= 0) {
        shot = s.shots.splice(i, 1)[0];
        break;
    }
} const target = p.scenes.find(s => s.id === targetSceneId); if (!shot || !target)
    throw Error('镜头或目标场景不存在'); const i = beforeId ? target.shots.findIndex(q => q.id === beforeId) : -1; target.shots.splice(i < 0 ? target.shots.length : i, 0, shot); }
export function duplicateShot(p, id) { for (const s of p.scenes) {
    const i = s.shots.findIndex(q => q.id === id);
    if (i < 0)
        continue;
    const q = clone(s.shots[i]);
    q.id = uid('shot');
    q.revision = 1;
    const remap = new Map();
    q.dialogue.forEach(d => { const old = d.id; d.id = uid('dialogue'); remap.set(old, d.id); });
    q.audio_continuations = q.audio_continuations.map(c => c.source_shot_id === id ? { ...c, source_shot_id: q.id, dialogue_id: remap.get(c.dialogue_id) ?? c.dialogue_id } : c);
    q.reference_bindings = q.reference_bindings.map(b => ({ ...b, ...(b.shot_ids ? { shot_ids: b.shot_ids.map(v => v === id ? q.id : v) } : {}) }));
    if (q.source)
        q.source = { ...q.source, duplicated_from: id };
    s.shots.splice(i + 1, 0, q);
    return q.id;
} throw Error('镜头不存在'); }
export function deletionImpact(p, ids) { const set = new Set(ids), rows = timeline(p); return { batches: p.generation_batches.filter(b => b.shot_ids.some(id => set.has(id))).map(b => b.id), continuations: rows.filter(r => !set.has(r.shot.id) && r.shot.audio_continuations.some(c => set.has(c.source_shot_id))).map(r => r.shot.id) }; }
export function deleteShots(p, ids) { const set = new Set(ids); p.archived_shots ??= []; for (const s of p.scenes) {
    for (const q of s.shots)
        if (set.has(q.id))
            p.archived_shots.push(clone(q));
    s.shots = s.shots.filter(q => !set.has(q.id));
} for (const { shot } of timeline(p))
    shot.audio_continuations = shot.audio_continuations.filter(c => !set.has(c.source_shot_id)); const clean = bindings => bindings.filter(b => !b.shot_ids?.length || b.shot_ids.some(id => !set.has(id))).map(b => b.shot_ids ? { ...b, shot_ids: b.shot_ids.filter(id => !set.has(id)) } : b); p.reference_bindings = clean(p.reference_bindings ?? []); for (const { shot } of timeline(p))
    shot.reference_bindings = clean(shot.reference_bindings); }
export function selection(p, ids) { const set = new Set(ids), rows = timeline(p), chosen = rows.filter(r => set.has(r.shot.id)); const positions = chosen.map(r => rows.findIndex(x => x.shot.id === r.shot.id)); const continuous = chosen.length > 0 && chosen.length === set.size && positions.every((v, i) => i === 0 || v === positions[i - 1] + 1); return { rows: chosen, continuous, duration_ms: chosen.reduce((n, r) => n + r.shot.duration_ms, 0), missing: chosen.length ? rows.slice(positions[0], positions.at(-1) + 1).filter(r => !set.has(r.shot.id)).map(r => r.number) : [] }; }
const applies = (b, rows) => !(b.scene_ids?.length && !rows.some(r => b.scene_ids.includes(r.scene.id))) && !(b.shot_ids?.length && !rows.some(r => b.shot_ids.includes(r.shot.id)));
export function inputSnapshot(p, ids) { const selected = selection(p, ids); const rows = selected.rows; const dialogueMap = new Map(timeline(p).flatMap(r => r.shot.dialogue.map(d => [d.id, { ...d, source_shot_id: r.shot.id }]))); return { metadata: clone(p.metadata ?? {}), settings: clone(p.settings), global_rules: clone(p.global_rules), synopsis: p.synopsis, characters: clone(p.characters), assets: clone(p.assets), reference_bindings: clone((p.reference_bindings ?? []).filter(b => applies(b, rows))), scenes: [...new Set(rows.map(r => r.scene.id))].map(id => { const s = p.scenes.find(s => s.id === id); return clone({ ...s, shots: undefined }); }), shots: rows.map(r => ({ id: r.shot.id, number: r.number, scene_id: r.scene.id, shot: clone(r.shot) })), external_dialogue: rows.flatMap(r => r.shot.audio_continuations.filter(c => !rows.some(row => row.shot.id === c.source_shot_id)).map(c => dialogueMap.get(c.dialogue_id))).filter(Boolean) }; }
export async function hashInput(value) { const bytes = new TextEncoder().encode(canonical(value)); return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join(''); }
export async function batchIsStale(p, b) { return await hashInput(inputSnapshot(p, b.shot_ids)) !== b.input_hash; }
const text = value => typeof value === 'string' ? value : Object.entries(value ?? {}).map(([k, v]) => `${k}：${text(v)}`).join('\n');
export function buildPrompt(p, ids) {
    const chosen = selection(p, ids);
    if (!chosen.continuous)
        throw Error(chosen.rows.length ? '请选择连续镜头；缺口：' + chosen.missing.join('、') : '请先选择镜头');
    const rows = chosen.rows, snapshot = inputSnapshot(p, ids);
    const refs = [...snapshot.reference_bindings, ...rows.flatMap(r => r.shot.reference_bindings.filter(b => applies(b, [r])))];
    const assetIds = [...new Set(refs.map(b => b.asset_id))];
    const reference_map = assetIds.map((asset_id, i) => ({ asset_id, reference_number: i + 1 }));
    const charName = id => p.characters.find(c => c.id === id)?.name ?? '待补充人物';
    const lines = ['【素材锁定】'];
    if (!assetIds.length)
        lines.push('参考图职责：尚未绑定参考素材，待补充。');
    for (const mapping of reference_map) {
        const a = p.assets.find(a => a.id === mapping.asset_id);
        lines.push(`参考${mapping.reference_number}「${a?.name ?? a?.path ?? '缺失素材'}」[素材ID：${mapping.asset_id}]`);
        for (const b of refs.filter(b => b.asset_id === mapping.asset_id)) {
            const subject = p.characters.find(c => c.id === b.subject_id)?.name ?? p.scenes.find(s => s.id === b.subject_id)?.location ?? '全局';
            const scope = [...(b.scene_ids ?? []).map(id => p.scenes.find(s => s.id === id)?.name ?? id), ...(b.shot_ids ?? []).map(id => '镜' + (rows.find(r => r.shot.id === id)?.number ?? id))].join('、');
            lines.push(`  职责：${subject}${scope ? '（' + scope + '）' : ''}；锁定：${b.locks || '待补充'}；忽略：${b.ignores || '待补充'}`);
        }
    }
    lines.push('固定人物（身份与造型仅在此定义一次；具体镜头的可见/画外/仅声音以原文和出场方式为准）：');
    for (const c of p.characters)
        lines.push(`${c.name}｜${c.age ?? '年龄待补充'}岁｜${c.role ?? ''}｜${c.description ?? ''}${c.appearance ? '｜造型：' + c.appearance : ''}`);
    lines.push('固定场景：');
    for (const s of snapshot.scenes)
        lines.push(`${s.name ?? s.location}｜${s.story_time}｜${s.interior_exterior}\n${s.spatial_setup}`);
    lines.push('必须忽略、禁止事项：' + (p.metadata?.format ?? p.global_rules.format ?? '待补充，以全局规则为准。'));
    lines.push('\n【一句话概述】', `${sec(chosen.duration_ms)}秒，镜${rows[0].number}—${rows.at(-1).number}；场景：${snapshot.scenes.map(s => s.location).join(' → ')}。故事核心：${p.synopsis || '待补充'}。核心行动、转折、最终状态及结尾画面严格依下列原分镜，不自动补写。`);
    lines.push('\n【全局设定】', `画幅：${p.settings.aspect_ratio}；帧率：${p.settings.fps}；平台：${p.settings.platform ?? '待选择'}；模型：${p.settings.model ?? '待选择'}；片段总时长：${sec(chosen.duration_ms)}秒。`, text(p.global_rules));
    lines.push('\n【时间轴分镜】');
    let cursor = 0;
    const said = new Set(), allDialogues = new Map(timeline(p).flatMap(r => r.shot.dialogue.map(d => [d.id, d])));
    for (const r of rows) {
        const q = r.shot;
        lines.push(`[${sec(cursor)}—${sec(cursor + q.duration_ms)}秒｜原镜号${r.number}：${q.framing}]`, `场景：${r.scene.location}；剧情时间：${r.scene.story_time}`, `第一帧状态：${q.first_frame || '待补充；原文中已写出的入点状态见人物动作。'}`, `摄影机：${q.camera || '待补充'}`, `人物动作：${q.action || '待补充'}`, `物理反馈：${q.physical_feedback || '未独立填写，保留动作原文，不自动推断。'}`, `环境反馈：${q.environment_feedback || '未独立填写，保留原文，不自动推断。'}`, `段落结果：${q.result || '待补充；依原文与剪辑衔接。'}`, `承接方式：${q.transition || '待补充'}`, `环境与动作声：${q.sound || '待补充'}`);
        if (q.character_presence?.length)
            lines.push('人物出场方式：' + q.character_presence.map(c => charName(c.character_id) + '＝' + ({ visible: '画内', offscreen: '画外', voice_only: '仅声音，禁止据此新增画内人物', unspecified: '待确认，遵照原文' }[c.mode])).join('；'));
        for (const d of q.dialogue) {
            if (!said.has(d.id)) {
                lines.push(`对白 ${charName(d.character_id)}（${d.source}）：${d.text}\n表演要求：${d.performance}`);
                said.add(d.id);
            }
        }
        for (const c of q.audio_continuations) {
            const from = allDialogues.get(c.dialogue_id);
            if (!said.has(c.dialogue_id) && from) {
                lines.push(`承接批次开始前的原语音 ${charName(from.character_id)}（${from.source}）：${from.text}\n表演要求：${from.performance}`);
                said.add(c.dialogue_id);
            }
            lines.push(`语音承接：延续对白ID ${c.dialogue_id} 的同一次发声，不重新起句、不重复播放。${c.note ?? ''}`);
        }
        if (q.continuity)
            lines.push('本镜连续性：' + q.continuity);
        cursor += q.duration_ms;
    }
    lines.push('\n【全局补充】', '固定人物与数量：沿用开头的人物及素材锁定，镜内人数以动作和明确出场方式为准；仅声音人物不进入画面。', '空间与先后顺序：沿用开头各场空间设定，按以上时间轴连续执行。', '每名角色的动作区分、接触、受力、惯性与恢复过程：保留原动作全文；未独立填写的信息待补充，不自动补写。', '停止后的呼吸、目光与环境变化：依各镜原文，不附加剧情动作。', '连续性与禁止事项：' + text(p.global_rules.continuity ?? p.global_rules));
    return { prompt: lines.join('\n'), reference_map, input_snapshot: snapshot, duration_ms: chosen.duration_ms, shot_ids: rows.map(r => r.shot.id), template_version: TEMPLATE_VERSION };
}
export function differences(before, after, limit = 60) { const result = []; function walk(a, b, path) { if (result.length >= limit || canonical(a) === canonical(b))
    return; if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys)
        walk(a[key], b[key], Array.isArray(a) ? `${path}[${key}]` : `${path}.${key}`);
}
else
    result.push({ path, before: a, after: b }); } walk(before, after, '$'); return result; }
