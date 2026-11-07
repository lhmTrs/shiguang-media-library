import * as M from './shared/model.mjs';
import { nameKey, fault } from '../project-assets/model.mjs';
const kinds = { character: '人物', scene: '场景', prop: '道具' };
const assert = (yes, message) => { if (!yes) throw fault(message); };
const key = v => nameKey(v);
const sourceId = row => row?.['编号'] ?? row?.id;
export function parseInitialization(value, { filename = '分镜.json', timing = 'duration' } = {}) {
  assert(value && typeof value === 'object' && !Array.isArray(value), '需要完整 JSON 对象');
  if(value['格式版本']!==undefined) assert(value['格式版本']==='2.0.0' && value['完整分镜']===true, '新版 JSON 需要格式版本 2.0.0、完整分镜 true');
  assert(value.complete !== false && value['完整分镜'] !== false && !['fragment','片段'].includes(value.document_type ?? value['文档类型']), '只能使用完整 JSON 初始化，不能导入片段');
  const input = structuredClone(value);
  if (Array.isArray(input['场景']) && input['素材清单']) {
    const chars=input['素材清单']['人物'];
    if(Array.isArray(chars)) {
      const names=new Map(chars.filter(c=>c&&typeof c==='object').map(c=>[sourceId(c),c['姓名']??c['名称']??c.name]));
      input['人物'] ??= chars.map(c=>typeof c==='string'?{'姓名':c}:{...c,'姓名':c['姓名']??c['名称']??c.name});
      for(const s of input['场景']) for(const q of s['镜头']??[]) for(const d of q['声音与对白']?.['对白']??[]) if(d['人物编号']) {
        assert(names.has(d['人物编号']),'对白人物编号不在素材清单中：'+d['人物编号']);
        if(d['人物']!==undefined) assert(key(d['人物'])===key(names.get(d['人物编号'])),'对白人物名称与编号不一致');
        d['人物']=names.get(d['人物编号']);
      }
    }
  }
  const result = M.importProject(input, { filename, timing });
  assert(result.project && !result.errors.length, '分镜格式错误：' + result.errors.map(e => e.path + '：' + e.message).join('\n'));
  const p = result.project;
  if(p.import_source) p.import_source.original=structuredClone(value);
  assert(p.scenes.length > 0 && M.timeline(p).length > 0 && p.scenes.every(s => s.shots.length > 0), '完整分镜至少包含一场一镜，各场不能没有镜头');
  assert(p.title.length <= 1000, '分镜标题过长');
  const manifest = [], maps = {}, rawManifest = value['素材清单'] ?? value.asset_manifest;
  assert(!rawManifest || typeof rawManifest === 'object' && !Array.isArray(rawManifest), '素材清单必须为对象');
  for (const [kind,label] of Object.entries(kinds)) {
    let rows = rawManifest?.[label] ?? rawManifest?.[kind];
    if (!rows) {
      if (rawManifest) throw fault('素材清单缺少“' + label + '”数组（没有时请填 []）');
      rows = kind === 'character' ? p.characters : kind === 'scene' ? [...new Map(p.scenes.map(s => [key(s.location || s.name),{name:s.location || s.name, id:s.id, description:s.spatial_setup}])).values()] : [];
      result.warnings.push({path:'素材清单.'+label,message:'旧格式未提供清单，按已有结构创建兼容清单；未猜测道具或长文本出场。'});
    }
    assert(Array.isArray(rows) && rows.length <= 10000, label + '清单须为数组且不超过 10000 条');
    const names = new Set(), ids = new Set(), lookup = new Map(); maps[kind] = lookup;
    for (const row of rows) {
      const name = typeof row === 'string' ? row : row?.['名称'] ?? row?.['姓名'] ?? row?.name;
      assert(typeof name === 'string' && !!name.trim() && name.trim().length <= 120 && !name.includes('\0'), label + '清单名称无效');
      const nk = key(name); assert(!names.has(nk), label + '清单名称重复：' + name); names.add(nk);
      const local = sourceId(row); if (local !== undefined) { assert(typeof local === 'string' && !!local.trim() && !ids.has(local), label + '清单编号重复或无效：' + local); ids.add(local); }
      const detail = kind === 'character' ? p.characters.find(c => key(c.name) === nk) : null;
      const entry = { kind, name:name.trim(), name_key:nk, source_id:local ?? detail?.id ?? null, source:structuredClone(typeof row==='object'&&Object.hasOwn(row,'source')?row.source:row), detail:detail ?? (typeof row === 'object' ? row : {}) };
      const alias=id=>{if(!id)return;const at='id:'+id;assert(!lookup.has(at)||lookup.get(at)===entry,label+'清单编号与正文编号冲突：'+id);lookup.set(at,entry);};
      manifest.push(entry); lookup.set(nk,entry); alias(local); alias(detail?.id);
    }
  }
  const charNames=new Set();
  for (const c of p.characters) { assert(!charNames.has(key(c.name)),'人物资料名称重复：'+c.name); charNames.add(key(c.name)); assert(maps.character.has(key(c.name)), '人物资料不在素材清单中：' + c.name); }
  // Explicit per-shot IDs are resolved only inside this file. Never use imported
  // database IDs as authority for matching existing project assets.
  const resolve = (kind,id,at) => { const e = maps[kind].get('id:'+id); assert(e, at + '引用清单中不存在的编号：' + id); return e; };
  for (const s of p.scenes) {
    const ref = s.source?.['场景编号'] ?? s.scene_asset_id;
    if (ref) s._scene_entry = resolve('scene',ref,'场景');
    for (const q of s.shots) {
      const chars = q.source?.['人物编号'] ?? q.character_ids;
      const props = q.source?.['道具编号'] ?? q.prop_ids ?? [];
      assert(Array.isArray(chars) && Array.isArray(props),'镜头人物编号和道具编号须为数组');
      q._character_entries = chars.map(id => resolve('character',id,'镜头人物'));
      q._prop_entries = props.map(id => resolve('prop',id,'镜头道具'));
      if (q.scene_asset_id ?? q.source?.['场景编号']) q._scene_entry = resolve('scene',q.scene_asset_id ?? q.source['场景编号'],'镜头场景');
      for (const d of q.dialogue) d._character_entry = resolve('character',d.character_id,'对白人物');
    }
  }
  return {project:p,manifest,maps,warnings:result.warnings,summary:{scenes:p.scenes.length,shots:M.timeline(p).length,duration_ms:M.duration(p),characters:manifest.filter(e=>e.kind==='character').length,scene_assets:manifest.filter(e=>e.kind==='scene').length,props:manifest.filter(e=>e.kind==='prop').length}};
}
export function bindInitialization(parsed, assetMap, documentId) {
  const p = parsed.project;
  const assetId = entry => assetMap.get(entry.kind + ':' + entry.name_key);
  const charIds = new Map(p.characters.map(c=>[c.id,assetId(parsed.maps.character.get(nameKey(c.name)))]));
  p.project_id = documentId; p.generation_batches=[]; p.generation_runs=[];
  p.characters = parsed.manifest.filter(e=>e.kind==='character').map(e=>({...e.detail,id:assetId(e),name:e.name}));
  p.asset_manifest = Object.fromEntries(Object.keys(kinds).map(kind=>[kind,parsed.manifest.filter(e=>e.kind===kind).map(e=>({id:assetId(e),name:e.name,source_id:e.source_id,source:e.source}))]));
  const rebind = b => { if (charIds.has(b.subject_id)) b.subject_id=charIds.get(b.subject_id); };
  p.reference_bindings.forEach(rebind);
  for (const s of p.scenes) {
    if (s._scene_entry) { s.scene_asset_id=assetId(s._scene_entry); delete s._scene_entry; }
    for (const q of s.shots) {
      q.character_ids = q._character_entries.map(assetId); delete q._character_entries;
      q.prop_ids=q._prop_entries.map(assetId); delete q._prop_entries;
      if (q._scene_entry) { q.scene_asset_id=assetId(q._scene_entry); delete q._scene_entry; }
      q.character_presence=q.character_presence.map(v=>({...v,character_id:charIds.get(v.character_id)??v.character_id}));
      for (const d of q.dialogue) { d.character_id=assetId(d._character_entry); delete d._character_entry; }
      q.reference_bindings.forEach(rebind);
    }
  }
  // The original file stays in import_source for unknown-field preservation,
  // while the current editable document has no storyboard history snapshots.
  const errors=M.validateProject(p); if(errors.length) throw fault('关联后分镜校验失败：'+errors.map(e=>e.path+':'+e.message).join('\n'));
  return p;
}
