// 第二期 P2a 第 1 步：项目资产页按作用域读取。
// 页内「第 N 集 ｜ 全剧 ｜ 公共人物库」、卡片来源标记、继承资产只读、全剧视图；项目未归剧 / 后端没有作用域接口时保持原有行为。
// 真实本地服务 + 合成剧集；作用域接口按 SERIES-P2a 合同 v1 的形状用测试替身返回（后端分支合入前）。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { projectInBar } from './helpers/path-bar.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-assets-scope-'));
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const checks = [], errors = [], seen = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal'), CODEX_HOME: path.join(temp, 'no-codex'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', MEDIA_CODEX_AUTOCONNECT: '0', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body, method) { const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json(); assert.ok(response.ok, p + ' ' + JSON.stringify(data)); return data; }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const rid = () => crypto.randomUUID();
const work = () => page.getByRole('region', { name: '项目资产库' });
const list = () => work().locator('section.ca-gallery').first();
const cards = () => list().locator('.ca-card:not(.ca-card-add) strong');
const card = name => list().locator('.ca-card').filter({ hasText: name });
const settled = async names => { await expect(list()).toHaveAttribute('aria-busy', 'false'); await expect(cards()).toHaveText(names); };
const nav = name => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true }).click();
const scopeSwitch = () => work().getByRole('group', { name: '看哪里的资产' });
const switchTo = name => scopeSwitch().getByRole('button', { name, exact: true }).click();
async function pickEpisode(id) { await projectInBar(page).getByRole('navigation', { name: '当前项目' }).getByRole('button').last().click(); await projectInBar(page).locator(`.ppb-option[data-target-project="${id}"]`).click(); await expect(projectInBar(page)).toHaveAttribute('data-project', id); }

// —— 作用域接口替身（合同 v1 形状）——
const fake = { receipts: {}, uploads: [], seasonOverrides: [], mode: 'contract', ctx: {}, shared: [], local: {}, writes: [], seriesAttrs: { asset_id: '', series_id: 'series', config_revision: 3, attribute_revision: 1, scores: { 'd-wealth': { value: 20, source: 'manual', reason: null, updated_at: 0 } } } };
const caps = (own) => ({ edit_base: own, create_override: !own, append: !own, promote: own, archive: own });
const item = (asset, owner) => ({ asset, owner, capabilities: caps(owner.type === 'project'), effective: {}, context_token: 'ctx-token', cover: null, look_count: asset.looks?.length ?? 0 });
async function routeScoped(route) {
  const url = new URL(route.request().url()); seen.push(url.pathname);
  const rcpt = url.pathname.match(/^\/api\/project-assets\/scoped-requests\/([^/]+)$/);
  if (rcpt) { fake.receiptReads = [...(fake.receiptReads || []), rcpt[1]]; const r = fake.receipts[rcpt[1]]; return route.fulfill({ json: r ? { found: true, result: r } : { found: false } }); }
  // 返工：本地图片上传（全剧 series_context_token / 本集 append_context_token），替身只记录请求、直接给 ready 回执
  const up = url.pathname.match(/^\/api\/project-assets\/image-imports(?:\/([^/]+)\/content)?$/);
  if (up) {
    if (!up[1]) { const body = route.request().postDataJSON(); fake.uploads.push(body); fake.upload = body; return route.fulfill({ json: { id: body.requestId, status: 'waiting', target: { assetId: body.assetId, projectId: body.projectId, lookId: body.lookId }, fileName: body.fileName, candidates: [] } }); }
    const b = fake.upload; return route.fulfill({ json: { id: b.requestId, status: 'ready', target: { assetId: b.assetId, projectId: b.projectId, lookId: b.lookId }, fileName: b.fileName, mediaAssetId: 'media-up-' + fake.uploads.length, candidates: [] } });
  }
  if (fake.mode === 'missing') return route.fulfill({ status: 404, json: { error: '旧版后端没有这个接口' } });
  if (fake.mode === 'html') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body>旧版后端把未知路径交给前端页面</body></html>' });
  const ctxMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/asset-context$/);
  if (ctxMatch) { const c = fake.ctx[ctxMatch[1]]; return c ? route.fulfill({ json: c }) : route.fulfill({ status: 404, json: { error: '项目不存在' } }); }
  // 第 3 步：同名检查、按作用域新建、集内追加造型
  const scopeOf = url.pathname.match(/^\/api\/project-assets\/scopes\/(series|season|episode)\/([^/]+)\/(names\/check|assets)$/);
  if (scopeOf && route.request().method() === 'POST') {
    const [, type, sid, what] = scopeOf, body = route.request().postDataJSON(); fake.writes.push({ method: 'POST', path: url.pathname, body });
    const shared = fake.shared.find(x => x.asset.kind === body.kind && x.asset.name === body.name), local = type === 'episode' ? (fake.local[sid] || []).find(x => x.asset.kind === body.kind && x.asset.name === body.name) : null;
    if (what === 'names/check') {
      if (local) return route.fulfill({ json: { status: 'existing_local', match: { id: local.asset.id, name: local.asset.name }, context_token: 'ctx-token' } });
      if (shared && type === 'episode') return route.fulfill({ json: { status: 'inherit_shared', match: { id: shared.asset.id, name: shared.asset.name }, context_token: 'ctx-token' } });
      if (shared) return route.fulfill({ json: { status: 'conflict', conflicts: [{ id: shared.asset.id, name: shared.asset.name, scope_name: '全剧' }], context_token: 'ctx-token' } });
      return route.fulfill({ json: { status: 'available', context_token: 'ctx-token' } });
    }
    if (body.on_shared === 'reuse' && shared) return route.fulfill({ json: { ...shared, reused: true } });
    const asset = { ...structuredClone(fake.template), id: crypto.randomUUID(), name: body.name, base_info: '', project_id: type === 'series' ? null : sid, looks: [], images: [], default_look_id: null, revision: 1 };
    const created = item(asset, type === 'series' ? { type: 'series', id: sid, name: '穿越计' } : { type: 'project', id: sid, name: '第1集' });
    if (type === 'series') fake.shared.push(created); else (fake.local[sid] ||= []).push(created);
    return route.fulfill({ json: created });
  }
  // 第 4 步：归档影响 / 提升
  const imp = url.pathname.match(/^\/api\/project-assets\/scopes\/(series|episode)\/([^/]+)\/assets\/([^/]+)\/(archive-impact|archive|promotion\/preview|promotion)$/);
  if (imp && route.request().method() === 'POST') {
    const [, , sid, aid, op] = imp, body = route.request().postDataJSON(); fake.writes.push({ method: 'POST', path: url.pathname, body });
    const ep = Object.values(fake.ctx).filter(c => c.series).map(c => c.project);
    if (op === 'archive-impact') {
      const needReplace = body.target.type === 'look' && body.target.id === 'look-a' && !body.replacement_id;
      fake.pendingArchive = { aid, target: body.target, replacement: body.replacement_id };
      return route.fulfill({ json: { preview_token: 'arch-' + (body.replacement_id || 'none'), impact: { seasons: [], episodes: [{ id: ep[0].id, name: '第1集', fields: [{ key: 'default_look', before: 'look-a', after: body.replacement_id ?? null, invalidates_override: true }] }], explicit_shots: [], blockers: needReplace ? [{ code: 'ASSET_REPLACEMENT_REQUIRED', candidates: [{ id: 'look-b', name: '囚服' }] }] : [] } } });
    }
    if (op === 'archive') { const hit = fake.shared.find(x => x.asset.id === aid); hit.asset = { ...hit.asset, looks: hit.asset.looks.map(l => l.id === fake.pendingArchive.target.id ? { ...l, archived_at: Date.now() } : l), default_look_id: fake.pendingArchive.replacement ?? hit.asset.default_look_id, revision: hit.asset.revision + 1 }; return route.fulfill({ json: { request_id: body.request_id, ...hit } }); }
    if (op === 'promotion/preview') return route.fulfill({ json: { preview_token: 'promo-1', impact: { seasons: [], episodes: [{ id: ep[0].id, name: '第1集', fields: [{ key: 'owner', before: { type: 'project' }, after: { type: 'series' } }] }, { id: ep[1].id, name: '第2集', fields: [{ key: 'visible', before: false, after: true }] }], explicit_shots: [], blockers: [] } } });
    const list = fake.local[sid] || [], at = list.findIndex(x => x.asset.id === aid), moved = list.splice(at, 1)[0];
    const promoted = { ...moved, asset: { ...moved.asset, project_id: null }, owner: { type: 'series', id: 'series', name: '穿越计' }, capabilities: caps(false) };
    fake.shared.push(promoted); return route.fulfill({ json: { request_id: body.request_id, ...promoted } });
  }
  const receiptPath = url.pathname.match(/^\/api\/project-assets\/scopes\/episode\/([^/]+)\/assets\/([^/]+)\/append\/media-receipt$/);
  if (receiptPath) { const body = route.request().postDataJSON(); fake.writes.push({ method: 'POST', path: url.pathname, body }); return route.fulfill({ json: { media_receipt_id: 'rc-' + body.media_asset_id, media_asset_id: body.media_asset_id, file_name: '夜景.png', preview_url: '', expires_at: Date.now() + 600000 } }); }
  const app = url.pathname.match(/^\/api\/project-assets\/scopes\/episode\/([^/]+)\/assets\/([^/]+)\/append(\/preview)?$/);
  if (app) {
    const body = route.request().postDataJSON(); fake.writes.push({ method: 'POST', path: url.pathname, body }); const hit = fake.shared.find(x => x.asset.id === app[2]);
    if (app[3]) { fake.pendingAppend = body.item; const first = body.item.type === 'image' ? !hit.asset.images.some(b => b.look_id === body.item.look_id) : hit.asset.looks.length === 0; return route.fulfill({ json: { preview_token: 'pv-' + fake.writes.length, sets_series_default: first, impact: { episodes: [] } } }); }
    if (fake.pendingAppend.type === 'image') { const b = { id: 'img-' + crypto.randomUUID().slice(0, 6), look_id: fake.pendingAppend.look_id, media_asset_id: 'media-lib-1', reference_type: '人物身份', purpose: '', locks: '', ignores: '', confirmed: false, archived_at: null, crop: { x: 50, y: 50, zoom: 1 }, last_known_name: '夜景.png' }; hit.asset = { ...hit.asset, images: [...hit.asset.images, b], revision: hit.asset.revision + 1 }; return route.fulfill({ json: { ...hit, effective: fake.effective[hit.asset.id] ?? hit.effective } }); }
    const look = { id: 'look-' + crypto.randomUUID().slice(0, 6), name: fake.pendingAppend.name, description: '', tags: [], default_image_id: null, archived_at: null };
    hit.asset = { ...hit.asset, looks: [...hit.asset.looks, look], default_look_id: hit.asset.default_look_id ?? (body.allow_series_default ? look.id : null), revision: hit.asset.revision + 1 };
    if (fake.effective[hit.asset.id]) fake.effective[hit.asset.id].default_images[look.id] = { value: null, source: { type: 'series', id: 'series', revision: 1 }, override: null, parent: null, write_token: 'wt-' + look.id };
    return route.fulfill({ json: { ...hit, effective: fake.effective[hit.asset.id] ?? hit.effective } });
  }
  const attrs = url.pathname.match(/^\/api\/project-assets\/scopes\/series\/([^/]+)\/assets\/([^/]+)\/attributes$/);
  if (attrs) {
    const a = fake.seriesAttrs;
    if (route.request().method() === 'PATCH') { const body = route.request().postDataJSON(); fake.writes.push({ method: 'PATCH', path: url.pathname, body });
      for (const c of body.changes) a.scores[c.dimension_id] = { value: c.value, source: 'manual', reason: null, updated_at: Date.now() }; a.attribute_revision++;
      return route.fulfill({ json: { ...a, request_id: body.request_id } }); }
    return route.fulfill({ json: a });
  }
  const so = url.pathname.match(/^\/api\/project-assets\/scopes\/season\/([^/]+)\/overrides$/);
  if (so) {
    const k = url.searchParams.get('kind') || 'character', pg = Number(url.searchParams.get('page') || 1), rows = fake.seasonOverrides.filter(r => r.asset.kind === k);
    if (fake.slowSeasonKind === k) await new Promise(r => setTimeout(r, 900));
    const size = fake.seasonPageSize || 100, items = rows.slice((pg - 1) * size, pg * size); fake.seasonPages = [...(fake.seasonPages || []), k + ':' + pg];
    return route.fulfill({ json: { scope: { type: 'season', id: so[1] }, context_token: 'season-token', total: rows.length, page: pg, items } });
  }
  // 返工：全剧维度配置的删除预览与保存（PATCH 带 request_id / context_token）
  const cfgw = url.pathname.match(/^\/api\/project-assets\/scopes\/series\/([^/]+)\/attribute-config(\/removal-preview)?$/);
  if (cfgw && route.request().method() !== 'GET') {
    const body = route.request().postDataJSON(); fake.writes.push({ method: route.request().method(), path: url.pathname, body });
    if (cfgw[2]) return route.fulfill({ json: { token: 'a'.repeat(64), config_revision: 3, affected: body.remove.map(id => ({ dimension_id: id, name: '维度' + id, scored_assets: 0, archived_scored_assets: 0, episode_overrides: 2 })) } });
    return route.fulfill({ json: { series_id: cfgw[1], revision: 4, source: 'user', updated_at: Date.now(), dimensions: body.dimensions.map((d, i) => ({ ...d, id: d.id ?? 'new-' + i })), request_id: body.request_id } });
  }
  const cfg = url.pathname.match(/^\/api\/project-assets\/scopes\/(series|season|episode)\/([^/]+)\/attribute-config$/);
  if (cfg && cfg[1] === 'series' && !url.search) return route.fulfill({ json: { series_id: cfg[2], revision: 3, source: 'user', updated_at: 0, dimensions: ['财力', '武力', '智谋', '名望'].map((n, i) => ({ id: i ? 'd-' + i : 'd-wealth', name: n, negative_label: '低', positive_label: '高', neutral_label: '中', criterion: '' })) } });
  if (cfg) { fake.cfgReads = [...(fake.cfgReads || []), url.search]; } if (cfg) return route.fulfill({ json: { series_id: 'series', revision: 3, source: 'user', updated_at: 0, dimensions: [{ id: 'd-wealth', name: '财力', negative_label: '贫', positive_label: '富', neutral_label: '中' }] } });
  const w = url.pathname.match(/^\/api\/project-assets\/scopes\/(series|season|episode)\/([^/]+)\/assets\/([^/]+)(\/overrides)?$/);
  const method = route.request().method();
  if (w && method !== 'GET') {
    const body = route.request().postDataJSON(); fake.writes.push({ method, path: url.pathname, body });
    if (w[4] && fake.dropBefore) { fake.dropBefore = false; return route.abort('connectionreset'); } // 没到服务端就断了：没有回执
    const hit = fake.shared.find(x => x.asset.id === w[3]) || Object.values(fake.local).flat().find(x => x.asset.id === w[3]);
    if (!hit) return route.fulfill({ status: 404, json: { error: '不在这个作用域' } });
    if (w[4] && w[1] === 'season') {
      const key = body.field.key + ':' + (body.field.look_id ?? ''); fake.seasonOverrides = fake.seasonOverrides.filter(r => r.asset.id !== w[3] || r.field.key + ':' + (r.field.look_id ?? '') !== key);
      if (body.action === 'set') fake.seasonOverrides.push({ asset: { id: hit.asset.id, name: hit.asset.name, kind: hit.asset.kind }, field: body.field, value: body.value, source: { type: 'season', id: w[2], revision: 1 }, override: { value: body.value, revision: 1 }, parent: { value: hit.asset.default_look_id, source: { type: 'series', id: 'series', revision: 1 } }, write_token: 'wt-season' });
      return route.fulfill({ json: hit });
    }
    if (w[4]) { // 本集覆盖：set / inherit
      const eff = fake.effective[w[3]], f = body.field.key === 'default_look' ? eff.default_look : body.field.key === 'attribute_score' ? eff.attribute_scores[body.field.dimension_id] : eff.default_images[body.field.look_id ?? 'null'];
      if (body.action === 'set') { f.value = body.field.key === 'attribute_score' ? { ...body.value, source: 'manual', reason: null, updated_at: Date.now() } : body.value; f.override = { value: f.value, revision: (f.override?.revision ?? 0) + 1 }; f.source = { type: 'episode', id: w[2], revision: 1 }; }
      else { f.value = f.parent.value; f.override = null; f.source = f.parent.source; }
      const result = { ...hit, effective: structuredClone(eff), context_token: 'ctx-token', request_id: body.request_id };
      if (fake.dropNext) { fake.dropNext = false; fake.receipts[body.request_id] = result; return route.abort('connectionreset'); }
      return route.fulfill({ json: result });
    }
    hit.asset = { ...body.asset, revision: body.expected_revision + 1 }; // 整份保存（全剧基础资料）
    return route.fulfill({ json: hit });
  }
  const m = url.pathname.match(/^\/api\/project-assets\/scopes\/(series|season|episode)\/([^/]+)\/assets(?:\/([^/]+))?$/);
  if (!m) return route.continue();
  const [, type, id, assetId] = m, kind = url.searchParams.get('kind') || 'character';
  const shared = fake.shared.filter(x => x.asset.kind === kind), local = type === 'episode' ? (fake.local[id] || []).filter(x => x.asset.kind === kind) : [];
  const all = [...shared, ...local];
  // 能力按作用域给：剧作用域里共享资产可编辑基础资料；集作用域里只能设本集覆盖
  const asScope = x => type === 'series' ? { ...x, capabilities: { ...x.capabilities, edit_base: true, create_override: false, append: false } } : x;
  if (assetId) { const hit = [...fake.shared, ...(fake.local[id] || [])].find(x => x.asset.id === assetId); return hit ? route.fulfill({ json: asScope(hit) }) : route.fulfill({ status: 404, json: { error: '不在这个作用域' } }); }
  return route.fulfill({ json: { scope: { type, id }, context_token: 'ctx-token', total: all.length, page: 1, items: all.map(asScope) } });
}

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  const s = await api('/project-series', { name: '穿越计', software: 'jianying', request_id: rid() });
  const q = await api(`/project-series/${s.id}/seasons`, { request_id: rid() });
  const eps = []; for (let i = 1; i <= 2; i++) eps.push((await api(`/project-series/${s.id}/episodes`, { season_id: q.id, expected_episode_no: i, request_id: rid() })).project);
  const solo = await api('/projects', { name: '独立短片' });
  // 真实资产：李四当作全剧共享（替身里 project_id 置空、归属剧），卖油郎是第 1 集自有；独立短片有自己的人物
  const lisi = await api('/project-assets/assets', { project_id: eps[0].id, kind: 'character', name: '李四' });
  const seller = await api('/project-assets/assets', { project_id: eps[0].id, kind: 'character', name: '卖油郎' });
  await api('/project-assets/assets', { project_id: solo.id, kind: 'character', name: '短片主角' });
  const seriesOwner = { type: 'series', id: s.id, name: s.name };
  const img = (id, look, name) => ({ id, look_id: look, media_asset_id: 'media-' + id, reference_type: '人物身份', purpose: '', locks: '', ignores: '', confirmed: false, archived_at: null, crop: { x: 50, y: 50, zoom: 1 }, last_known_name: name });
  const lisiShared = { ...lisi, project_id: null, looks: [{ id: 'look-a', name: '常服', description: '', tags: [], default_image_id: 'img-1', archived_at: null }, { id: 'look-b', name: '囚服', description: '', tags: [], default_image_id: 'img-3', archived_at: null }], default_look_id: 'look-a', images: [img('img-1', 'look-a', '常服正面.png'), img('img-2', 'look-a', '常服侧面.png'), img('img-3', 'look-b', '囚服.png')] };
  const src = (type, sid) => ({ type, id: sid, revision: 1 });
  fake.seriesAttrs.asset_id = lisi.id; fake.seriesAttrs.series_id = s.id;
  fake.effective = { [lisi.id]: {
    attribute_config_revision: 3,
    default_look: { value: 'look-b', source: src('season', 'season'), override: null, parent: { value: 'look-b', source: src('season', 'season') }, write_token: 'wt-look' },
    attribute_scores: { 'd-wealth': { value: { value: 20, source: 'manual', reason: null, updated_at: 0 }, source: src('series', 'series'), override: null, parent: { value: { value: 20, source: 'manual', reason: null, updated_at: 0 }, source: src('series', 'series') }, write_token: 'wt-score' } },
    default_images: { 'look-a': { value: 'img-1', source: src('series', 'series'), override: null, parent: { value: 'img-1', source: src('series', 'series') }, write_token: 'wt-img-a' }, 'look-b': { value: 'img-3', source: src('series', 'series'), override: null, parent: { value: 'img-3', source: src('series', 'series') }, write_token: 'wt-img-b' } } } };
  const foreman = await api('/project-assets/assets', { project_id: eps[1].id, kind: 'character', name: '工头' });
  fake.template = seller;
  fake.shared = [{ ...item(lisiShared, seriesOwner), effective: fake.effective[lisi.id] }, item({ ...foreman, project_id: null, looks: [], images: [], default_look_id: null }, seriesOwner)];
  fake.local[eps[0].id] = [item(seller, { type: 'project', id: eps[0].id, name: eps[0].name })];
  for (const e of eps) fake.ctx[e.id] = { project: { id: e.id, name: e.name }, series: { id: s.id, name: s.name }, season: { id: q.id, name: '第 1 季' }, membership_revision: 1, context_token: 'ctx-' + e.id };
  fake.ctx[solo.id] = { project: { id: solo.id, name: solo.name }, series: null, season: null, membership_revision: 1, context_token: 'ctx-solo' };

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => { try { localStorage.setItem('shiguang.refreshSeconds', '0'); } catch {} });
  await context.route(u => /\/api\/projects\/[^/]+\/asset-context$/.test(new URL(u).pathname) || new URL(u).pathname.startsWith('/api/project-assets/scopes/') || new URL(u).pathname.startsWith('/api/project-assets/scoped-requests/') || new URL(u).pathname.startsWith('/api/project-assets/image-imports'), routeScoped);
  await context.route(u => new URL(u).pathname === '/api/assets' && new URL(u).searchParams.get('kind') === 'photo', r => r.fulfill({ json: { items: [{ id: 'media-lib-1', name: '夜景.png' }], total: 1 } }));
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/#/projects'); await expect(projectInBar(page)).toHaveAttribute('data-project', /./);
  await pickEpisode(eps[0].id); await nav('项目资产');

  await check('集视图：页内三段切换；列表 = 全剧共享 + 本集自有，卡片标来源', async () => {
    await expect(scopeSwitch().getByRole('button')).toHaveText([/第1集|穿越计/, '全剧', '公共人物库']);
    await expect(scopeSwitch().getByRole('button').first()).toHaveAttribute('aria-pressed', 'true');
    await settled(['李四', '工头', '卖油郎']);
    await expect(card('李四').locator('.ca-owner-src')).toHaveText('全剧'); await expect(card('卖油郎').locator('.ca-owner-src')).toHaveText('只在本集');
    assert.ok(seen.some(p => p === `/api/project-assets/scopes/episode/${eps[0].id}/assets`), '集视图应走作用域列表接口');
  });

  await check('继承自全剧的资产在集视图只读并说明原因；本集自有资产照常可编辑', async () => {
    await card('李四').click(); await expect(work().locator('.ca-name-input')).toHaveValue('李四');
    await expect(work().locator('.ca-scope-lock')).toContainText('全剧共享的资产'); await expect(work().locator('.ca-name-input')).toBeDisabled();
    await expect(work().getByLabel('基础信息', { exact: true })).toBeDisabled();
    await card('卖油郎').click(); await expect(work().locator('.ca-name-input')).toHaveValue('卖油郎');
    await expect(work().locator('.ca-scope-lock')).toHaveCount(0); await expect(work().locator('.ca-name-input')).toBeEnabled();
    await work().getByLabel('基础信息', { exact: true }).fill('本集自有的资料'); await work().getByRole('button', { name: '保存资料', exact: true }).click();
    await expect(work().getByRole('button', { name: '保存资料', exact: true })).toBeDisabled();
    // 作用域模式下本集自有资产也走 <scope>/assets/:id 保存（合同：本集自有资料按原方式编辑），带令牌与请求号
    const own = fake.writes.at(-1); assert.equal(own.method, 'PUT'); assert.equal(own.path, `/api/project-assets/scopes/episode/${eps[0].id}/assets/${seller.id}`); assert.equal(own.body.asset.base_info, '本集自有的资料'); assert.equal(own.body.context_token, 'ctx-token');
  });

  await check('本集设置：显示实际生效的默认造型和来源；本集改默认造型 / 默认图带令牌写入，恢复上层回到上层值', async () => {
    await card('李四').click(); const panel = work().getByRole('region', { name: '本集设置' }); await expect(panel).toBeVisible();
    const lookRow = panel.getByRole('group', { name: '默认造型' });
    await expect(lookRow.getByRole('button', { name: '囚服', exact: true })).toHaveAttribute('aria-pressed', 'true'); await expect(lookRow.locator('.ca-src-tag')).toHaveText('本季');
    await expect(lookRow.getByRole('button', { name: /恢复上层/ })).toHaveCount(0);
    await lookRow.getByRole('button', { name: '常服', exact: true }).click();
    await expect(lookRow.getByRole('button', { name: '常服', exact: true })).toHaveAttribute('aria-pressed', 'true'); await expect(lookRow.locator('.ca-src-tag')).toHaveText('本集');
    const w1 = fake.writes.at(-1); assert.equal(w1.method, 'PATCH'); assert.equal(w1.path, `/api/project-assets/scopes/episode/${eps[0].id}/assets/${lisi.id}/overrides`);
    assert.deepEqual({ field: w1.body.field, action: w1.body.action, value: w1.body.value, write_token: w1.body.write_token, context_token: w1.body.context_token }, { field: { key: 'default_look' }, action: 'set', value: 'look-a', write_token: 'wt-look', context_token: 'ctx-token' });
    assert.match(w1.body.request_id, /^[0-9a-f-]{36}$/);
    // 下面只读的造型列表也按本集实际生效显示默认
    await lookRow.getByRole('button', { name: /恢复上层（本季）/ }).click(); await expect(lookRow.locator('.ca-src-tag')).toHaveText('本季');
    assert.equal(fake.writes.at(-1).body.action, 'inherit'); assert.equal('value' in fake.writes.at(-1).body, false);
    // 当前造型（常服）的默认图：本集换成侧面
    await work().locator('.ca-look-list button').filter({ hasText: '常服' }).click();
    const imgRow = panel.getByRole('group', { name: '造型「常服」的默认图' }); await expect(imgRow.locator('.ca-src-tag')).toHaveText('全剧');
    await imgRow.getByRole('button', { name: '设为本集默认图：常服侧面.png' }).click(); await expect(imgRow.locator('.ca-src-tag')).toHaveText('本集');
    assert.deepEqual(fake.writes.at(-1).body.field, { key: 'default_image', look_id: 'look-a' }); assert.equal(fake.writes.at(-1).body.write_token, 'wt-img-a');
    await expect(work().locator('.ca-name-input')).toBeDisabled();
    // 评分按维度：本集改分 → 来源变本集；恢复全剧 → 回到全剧值。旧的项目评分组件不出现（共享人物没有项目 ID）
    const score = panel.getByRole('group', { name: '评分「财力」' });
    await expect(score.locator('.ca-score-now')).toContainText('+20'); await expect(score.locator('.ca-src-tag')).toHaveText('全剧');
    await score.getByLabel('财力本集分数').fill('35'); await score.getByRole('button', { name: '本集改分' }).click();
    await expect(score.locator('.ca-src-tag')).toHaveText('本集'); await expect(score.locator('.ca-score-now')).toContainText('+35');
    const ws = fake.writes.at(-1); assert.deepEqual({ field: ws.body.field, action: ws.body.action, value: ws.body.value, write_token: ws.body.write_token }, { field: { key: 'attribute_score', dimension_id: 'd-wealth' }, action: 'set', value: { value: 35 }, write_token: 'wt-score' });
    await score.getByRole('button', { name: /恢复全剧/ }).click(); await expect(score.locator('.ca-src-tag')).toHaveText('全剧'); await expect(score.locator('.ca-score-now')).toContainText('+20');
    assert.equal(fake.writes.at(-1).body.action, 'inherit');
    // 本集明确设为「未评」：仍是本集覆盖（来源本集、显示未评），不是恢复全剧；恢复全剧才回到全剧分
    await score.getByLabel('财力本集分数').fill(''); await score.getByRole('button', { name: '本集改分' }).click();
    await expect(score.locator('.ca-src-tag')).toHaveText('本集'); await expect(score.locator('.ca-score-now')).toContainText('未评');
    assert.deepEqual(fake.writes.at(-1).body.value, { value: null }); assert.equal(fake.writes.at(-1).body.action, 'set');
    await score.getByRole('button', { name: /恢复全剧/ }).click(); await expect(score.locator('.ca-score-now')).toContainText('+20');
    await expect(work().getByRole('region', { name: '属性' })).toContainText('评分在上方「本集设置」里按维度覆盖');
    assert.ok(fake.cfgReads.includes('?asset_id=' + lisi.id), '集视图读维度要带当前人物 ID');
  });

  await check('全剧视图：可以编辑全剧基础资料，保存走剧作用域并带令牌；归档造型改走影响预览', async () => {
    await scopeSwitch().getByRole('button', { name: '全剧', exact: true }).click(); await settled(['李四', '工头']); await card('李四').click();
    await expect(work().locator('.ca-scope-lock')).toHaveCount(0); await expect(work().getByRole('region', { name: '本集设置' })).toHaveCount(0);
    await work().getByLabel('基础信息', { exact: true }).fill('全剧的李四资料'); await work().getByRole('button', { name: '保存资料', exact: true }).click();
    await expect(work().getByRole('button', { name: '保存资料', exact: true })).toBeDisabled();
    const w = fake.writes.at(-1); assert.equal(w.method, 'PUT'); assert.equal(w.path, `/api/project-assets/scopes/series/${s.id}/assets/${lisi.id}`);
    assert.equal(w.body.asset.base_info, '全剧的李四资料'); assert.equal(w.body.context_token, 'ctx-token'); assert.match(w.body.request_id, /^[0-9a-f-]{36}$/); assert.equal(typeof w.body.expected_revision, 'number');
    // 全剧评分：按剧作用域读写，带令牌和两个版本号
    const attrBox = work().getByRole('region', { name: '人物属性' }); await expect(attrBox).toBeVisible();
    await expect(attrBox.getByRole('button', { name: '维度设置…' })).toHaveCount(0);
    await attrBox.getByRole('button', { name: '编辑' }).click(); await attrBox.getByLabel('财力数值').fill('-15'); await attrBox.getByRole('button', { name: '保存属性' }).click();
    await expect(attrBox.getByRole('button', { name: '编辑' })).toBeVisible();
    const wa = fake.writes.at(-1); assert.equal(wa.path, `/api/project-assets/scopes/series/${s.id}/assets/${lisi.id}/attributes`);
    assert.deepEqual({ changes: wa.body.changes, cfg: wa.body.expected_config_revision, rev: wa.body.expected_attribute_revision, ctx: wa.body.context_token }, { changes: [{ dimension_id: 'd-wealth', value: -15 }], cfg: 3, rev: 1, ctx: 'ctx-token' });
    assert.match(wa.body.request_id, /^[0-9a-f-]{36}$/);
    await work().getByRole('navigation', { name: '详情分区' }).getByRole('button', { name: '造型与参考图', exact: true }).click();
    await work().locator('.ca-look-config > summary').click(); await expect(work().getByRole('button', { name: '归档造型', exact: true })).toBeEnabled(); // 第 4 步起：全剧里归档走影响预览
    await scopeSwitch().getByRole('button').first().click(); await settled(['李四', '工头', '卖油郎']);
  });

  await check('新建同名：全剧已有 → 问继承还是另建；继承打开全剧的那个人；另建需改名；本集已有同名直接说明', async () => {
    const createBtn = () => work().getByRole('button', { name: /^新建/ }).first(), dlg = () => page.getByRole('dialog', { name: '新建资产' });
    await createBtn().click(); await dlg().getByLabel('新资产名称').fill('李四'); await dlg().getByRole('button', { name: '创建并编辑' }).click();
    await expect(dlg().getByRole('alert')).toContainText('全剧已经有「李四」');
    await dlg().getByRole('button', { name: '继承全剧的「李四」' }).click(); await expect(dlg()).toHaveCount(0);
    await expect(work().locator('.ca-name-input')).toHaveValue('李四'); await expect(work().getByRole('region', { name: '本集设置' })).toBeVisible();
    const reuse = fake.writes.filter(w => w.path.endsWith('/assets') && w.method === 'POST').at(-1); assert.equal(reuse.body.on_shared, 'reuse'); assert.equal(reuse.body.name, '李四');
    await createBtn().click(); await dlg().getByLabel('新资产名称').fill('李四'); await dlg().getByRole('button', { name: '创建并编辑' }).click();
    await dlg().getByRole('button', { name: '新建另一个（改个名字）' }).click(); await expect(dlg()).toContainText('同一部剧里不能有两个同名');
    await dlg().getByLabel('新资产名称').fill('李四（少年）'); await dlg().getByRole('button', { name: '创建并编辑' }).click(); await expect(dlg()).toHaveCount(0);
    await expect(work().locator('.ca-name-input')).toHaveValue('李四（少年）'); await expect(card('李四（少年）').locator('.ca-owner-src')).toHaveText('只在本集');
    await createBtn().click(); await dlg().getByLabel('新资产名称').fill('卖油郎'); await dlg().getByRole('button', { name: '创建并编辑' }).click();
    await expect(work().getByRole('alert').first()).toContainText('本集已有同名的「卖油郎」'); await dlg().getByRole('button', { name: '关闭弹窗' }).click();
  });

  await check('本集追加造型：预览后确认，写到全剧；成为全剧默认时必须勾选才可确认', async () => {
    await list().locator('.ca-card').filter({ hasText: /^李四$/ }).or(list().locator('.ca-card').filter({ has: page.locator('strong', { hasText: /^李四$/ }) })).first().click(); await expect(work().locator('.ca-name-input')).toHaveValue('李四');
    const panel = work().getByRole('region', { name: '本集设置' });
    await panel.getByLabel('新造型名称').fill('夜行服'); await expect(panel.getByLabel('新造型名称')).toHaveValue('夜行服'); await panel.getByRole('button', { name: '预览' }).click();
    const box = panel.getByRole('group', { name: '确认新增造型' }); await expect(box).toContainText('会加到「穿越计」全剧的这个人物上'); await expect(box.getByRole('checkbox')).toHaveCount(0);
    await box.getByRole('button', { name: '确认新增' }).click(); await expect(panel.getByRole('group', { name: '默认造型' }).getByRole('button', { name: '夜行服', exact: true })).toBeVisible();
    const pv = fake.writes.find(w => w.path.endsWith('/append/preview')); assert.deepEqual(pv.body.item, { type: 'look', name: '夜行服' }); assert.equal(pv.body.context_token, 'ctx-token');
    const cf = fake.writes.filter(w => w.path.endsWith('/append')).at(-1); assert.equal(cf.body.preview_token, pv ? 'pv-' + (fake.writes.indexOf(pv) + 1) : ''); assert.equal('allow_series_default' in cf.body, false);
    // 工头还没有任何造型：第一个造型会成为全剧默认，必须勾选
    await card('工头').click(); await expect(work().locator('.ca-name-input')).toHaveValue('工头'); await panel.getByLabel('新造型名称').fill('短打'); await expect(panel.getByLabel('新造型名称')).toHaveValue('短打'); await panel.getByRole('button', { name: '预览' }).click();
    const box2 = panel.getByRole('group', { name: '确认新增造型' }); await expect(box2).toContainText('会成为全剧默认造型');
    await expect(box2.getByRole('button', { name: '确认新增' })).toBeDisabled(); await box2.getByRole('checkbox').check(); await box2.getByRole('button', { name: '确认新增' }).click();
    await expect(box2).toHaveCount(0); assert.equal(fake.writes.filter(w => w.path.endsWith('/append')).at(-1).body.allow_series_default, true);
  });

  await check('本集追加图片：素材库选图 → 签发回执 → 预览 → 确认，写到全剧当前造型', async () => {
    await list().locator('.ca-card').filter({ has: page.locator('strong', { hasText: /^李四$/ }) }).first().click(); await expect(work().locator('.ca-name-input')).toHaveValue('李四');
    await work().locator('.ca-look-list button').filter({ hasText: '常服' }).click();
    const panel = work().getByRole('region', { name: '本集设置' }); await panel.getByRole('group', { name: '造型「常服」的默认图' }).getByRole('button', { name: '从素材库添加图片' }).click();
    await page.getByRole('dialog', { name: '选择素材库图片' }).getByRole('button', { name: /夜景\.png/ }).click();
    const confirm = page.getByRole('dialog', { name: '确认追加图片' }); await expect(confirm).toContainText('会加到「穿越计」全剧「李四」的造型「常服」');
    await expect(confirm.getByRole('checkbox')).toHaveCount(0); await confirm.getByRole('button', { name: '确认追加' }).click(); await expect(confirm).toHaveCount(0);
    const rc = fake.writes.filter(w => w.path.endsWith('/append/media-receipt')).at(-1); assert.deepEqual({ look_id: rc.body.look_id, media_asset_id: rc.body.media_asset_id, ctx: rc.body.context_token }, { look_id: 'look-a', media_asset_id: 'media-lib-1', ctx: 'ctx-token' });
    const pv = fake.writes.filter(w => w.path.endsWith('/append/preview')).at(-1); assert.deepEqual(pv.body.item, { type: 'image', look_id: 'look-a', media_receipt_id: 'rc-media-lib-1' });
    await expect(panel.getByRole('button', { name: '设为本集默认图：夜景.png' })).toBeVisible();
  });

  await check('切到「全剧」：顶栏不变，提示条说明，只列共享资产，新建的是全剧人物', async () => {
    await switchTo('全剧'); await expect(scopeSwitch().getByRole('button', { name: '全剧', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(work().locator('.ca-series-note')).toContainText('正在看「穿越计」全剧的资产');
    await settled(['李四', '工头']); await expect(projectInBar(page)).toHaveAttribute('data-project', eps[0].id);
    assert.ok(seen.some(p => p === `/api/project-assets/scopes/series/${s.id}/assets`), '全剧视图应走剧作用域');
    await work().getByRole('button', { name: /^新建/ }).first().click(); await page.getByRole('dialog', { name: '新建资产' }).getByLabel('新资产名称').fill('王五');
    await expect(page.getByRole('dialog', { name: '新建资产' })).toContainText('这个人物会在整部剧共享'); await page.getByRole('dialog', { name: '新建资产' }).getByRole('button', { name: '创建并编辑' }).click();
    await expect(work().locator('.ca-name-input')).toHaveValue('王五'); assert.equal(fake.writes.filter(w => w.path === `/api/project-assets/scopes/series/${s.id}/assets`).length, 1);
    // 回到集视图；去公共人物库再回来也回到集视图
    await switchTo('第1集').catch(() => scopeSwitch().getByRole('button').first().click()); await settled(['李四', '工头', '王五', '卖油郎', '李四（少年）']);
    await switchTo('全剧'); await settled(['李四', '工头', '王五']); await switchTo('公共人物库'); await expect(work().locator('.ca-series-note')).toHaveCount(0);
    await scopeSwitch().getByRole('button').first().click(); await settled(['李四', '工头', '王五', '卖油郎', '李四（少年）']);
  });

  await check('换集：回到「第 N 集」视图并读新的作用域', async () => {
    await switchTo('全剧'); await settled(['李四', '工头', '王五']);
    await page.getByRole('button', { name: '下一集：第2集' }).click(); await expect(projectInBar(page)).toHaveAttribute('data-project', eps[1].id);
    await expect(scopeSwitch().getByRole('button').first()).toHaveAttribute('aria-pressed', 'true'); await settled(['李四', '工头', '王五']);
    assert.ok(seen.some(p => p === `/api/project-assets/scopes/episode/${eps[1].id}/assets`));
  });

  await check('提升到全剧：本集自有资产先看影响（哪些集会看到它），确认后变成全剧共享', async () => {
    await pickEpisode(eps[0].id); await expect(list()).toHaveAttribute('aria-busy', 'false');
    await card('卖油郎').click(); await expect(work().locator('.ca-name-input')).toHaveValue('卖油郎');
    await work().getByRole('button', { name: '资料操作', exact: true }).click(); await work().getByRole('menuitem', { name: '提升到全剧…' }).click();
    const dlg = page.getByRole('dialog', { name: '把「卖油郎」提升到全剧' }); await expect(dlg).toContainText('第2集'); await expect(dlg).toContainText('在这里可见：否 → 是');
    await dlg.getByRole('button', { name: '确认提升' }).click(); await expect(dlg).toHaveCount(0);
    await expect(card('卖油郎').locator('.ca-owner-src')).toHaveText('全剧');
    const w = fake.writes.filter(x => x.path.endsWith('/promotion')).at(-1); assert.equal(w.body.preview_token, 'promo-1'); assert.match(w.body.request_id, /^[0-9a-f-]{36}$/);
  });

  await check('全剧里归档默认造型：先要选替代，选好后重新预览才能确认', async () => {
    await scopeSwitch().getByRole('button', { name: '全剧', exact: true }).click(); await expect(list()).toHaveAttribute('aria-busy', 'false');
    await list().locator('.ca-card').filter({ has: page.locator('strong', { hasText: /^李四$/ }) }).first().click(); await expect(work().locator('.ca-name-input')).toHaveValue('李四');
    await work().getByRole('navigation', { name: '详情分区' }).getByRole('button', { name: '造型与参考图', exact: true }).click();
    await work().locator('.ca-look-list button').filter({ hasText: '常服' }).click(); await work().locator('.ca-look-config > summary').click();
    await work().getByRole('button', { name: '归档造型', exact: true }).click();
    const dlg = page.getByRole('dialog', { name: '归档造型「常服」' }); await expect(dlg.getByRole('alert')).toContainText('先选一个替代');
    await expect(dlg.getByRole('button', { name: '确认归档' })).toBeDisabled();
    await dlg.getByLabel('选择替代项').selectOption('look-b'); await expect(dlg.getByRole('alert')).toHaveCount(0);
    await expect(dlg).toContainText('默认造型：常服 → 囚服（本层的单独设置会失效）'); await dlg.getByRole('button', { name: '确认归档' }).click(); await expect(dlg).toHaveCount(0);
    const pv = fake.writes.filter(x => x.path.endsWith('/archive-impact')).at(-1); assert.deepEqual({ target: pv.body.target, rep: pv.body.replacement_id }, { target: { type: 'look', id: 'look-a' }, rep: 'look-b' });
    assert.equal(fake.writes.filter(x => x.path.endsWith('/archive')).at(-1).body.preview_token, 'arch-look-b');
    await scopeSwitch().getByRole('button').first().click();
  });

  await check('本季设定：列出本季已有设置；新增本季默认造型走季层覆盖，恢复全剧后清空', async () => {
    await work().getByRole('button', { name: '第 1 季设定' }).click();
    const dlg = page.getByRole('dialog', { name: '第 1 季 · 本季设定' }); await expect(dlg).toContainText('这一季还没有单独设置');
    await dlg.getByLabel('选择资产').selectOption({ label: '李四' }); await dlg.getByLabel('选择设置项').selectOption({ index: 1 });
    await dlg.getByLabel('选择本季的值').selectOption({ label: '夜行服' }); await dlg.getByRole('button', { name: '设为本季' }).click();
    const row = dlg.getByRole('row').filter({ hasText: '李四' }); await expect(row).toContainText('默认造型'); await expect(row).toContainText('夜行服');
    const w = fake.writes.filter(x => x.path.includes('/scopes/season/') && x.path.endsWith('/overrides')).at(-1);
    assert.deepEqual({ field: w.body.field, action: w.body.action, ctx: w.body.context_token }, { field: { key: 'default_look' }, action: 'set', ctx: 'season-token' });
    await dlg.getByRole('button', { name: '恢复全剧：李四 默认造型' }).click(); await expect(dlg).toContainText('这一季还没有单独设置');
    assert.equal(fake.writes.filter(x => x.path.includes('/scopes/season/')).at(-1).body.action, 'inherit');
    await dlg.getByRole('button', { name: '关闭' }).click(); await expect(dlg).toHaveCount(0);
  });


  // —— 返工（Codex 复验 BLOCKED 8 项）的反例 ——
  const seasonDlg = () => page.getByRole('dialog', { name: '第 1 季 · 本季设定' });
  await check('返工·本季设定：写入带来源集和它的令牌；这一集换季后旧弹窗关闭，不再写旧季', async () => {
    await work().getByRole('button', { name: '第 1 季设定' }).click(); const dlg = seasonDlg(); await expect(dlg).toContainText('这一季还没有单独设置');
    await dlg.getByLabel('选择资产').selectOption({ label: '李四' }); await dlg.getByLabel('选择设置项').selectOption({ index: 1 });
    await dlg.getByLabel('选择本季的值').selectOption({ label: '夜行服' }); await dlg.getByRole('button', { name: '设为本季' }).click();
    await expect(dlg.getByRole('row').filter({ hasText: '李四' })).toContainText('夜行服');
    const w = fake.writes.filter(x => x.path.includes('/scopes/season/')).at(-1);
    assert.deepEqual({ p: w.body.source_project_id, t: w.body.source_context_token }, { p: eps[0].id, t: 'ctx-' + eps[0].id });
    const before = fake.writes.length; fake.ctx[eps[0].id] = { ...fake.ctx[eps[0].id], season: { id: 'season-2', name: '第 2 季' }, membership_revision: 2, context_token: 'ctx-moved' };
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(dlg).toHaveCount(0); await expect(page.getByText(/所属季刚变了/).first()).toBeVisible();
    await expect(work().getByRole('button', { name: '第 2 季设定' })).toBeVisible(); assert.equal(fake.writes.length, before, '换季后不应再写旧季');
    fake.ctx[eps[0].id] = { ...fake.ctx[eps[0].id], season: { id: q.id, name: '第 1 季' }, membership_revision: 3, context_token: 'ctx-' + eps[0].id }; fake.seasonOverrides = [];
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(work().getByRole('button', { name: '第 1 季设定' })).toBeVisible();
  });

  await check('返工·本季设定：多于一页全部读出；慢的旧类别响应不会盖掉新类别', async () => {
    const row = (field, value) => ({ asset: { id: lisi.id, name: '李四', kind: 'character' }, field, value, source: { type: 'season', id: q.id, revision: 1 }, override: { value, revision: 1 }, parent: { value: null, source: { type: 'series', id: s.id, revision: 1 } }, write_token: 'wt-s-' + field.key });
    fake.seasonOverrides = [row({ key: 'default_look' }, 'look-b'), row({ key: 'default_image', look_id: 'look-b' }, 'img-3')]; fake.seasonPageSize = 1; fake.seasonPages = [];
    await work().getByRole('button', { name: '第 1 季设定' }).click(); const dlg = seasonDlg();
    await expect(dlg.getByRole('row').filter({ hasText: '李四' })).toHaveCount(2);
    assert.deepEqual(fake.seasonPages.filter(x => x.startsWith('character')), ['character:1', 'character:2']);
    await dlg.getByRole('button', { name: '关闭' }).click(); await expect(dlg).toHaveCount(0);
    fake.slowSeasonKind = 'character'; await work().getByRole('button', { name: '第 1 季设定' }).click();
    await dlg.getByRole('tab', { name: '场景' }).click(); await expect(dlg).toContainText('这一季还没有单独设置');
    await page.waitForTimeout(1300); await expect(dlg.getByRole('row').filter({ hasText: '李四' })).toHaveCount(0);
    await expect(dlg.getByRole('tab', { name: '场景' })).toHaveAttribute('aria-selected', 'true'); await expect(dlg).toContainText('这一季还没有单独设置');
    fake.slowSeasonKind = ''; fake.seasonPageSize = 0; fake.seasonOverrides = []; await dlg.getByRole('button', { name: '关闭' }).click();
  });

  await check('返工·响应丢失：先按原请求号查回执；查不到才用同一编号、同一内容重发一次', async () => {
    await list().locator('.ca-card').filter({ has: page.locator('strong', { hasText: /^李四$/ }) }).first().click(); await expect(work().locator('.ca-name-input')).toHaveValue('李四');
    const lookRow = work().getByRole('region', { name: '本集设置' }).getByRole('group', { name: '默认造型' });
    // 已提交但响应丢了：回执里有，直接用回执，不重发
    fake.dropNext = true; fake.receiptReads = []; let n = fake.writes.length;
    await lookRow.getByRole('button', { name: '夜行服', exact: true }).click(); await expect(lookRow.locator('.ca-src-tag')).toHaveText('本集');
    let sent = fake.writes.slice(n).filter(w => w.path.endsWith('/overrides')); assert.equal(sent.length, 1); assert.deepEqual(fake.receiptReads, [sent[0].body.request_id]);
    // 没到服务端：回执里没有，用同一个编号重发
    fake.dropBefore = true; fake.receiptReads = []; n = fake.writes.length;
    await lookRow.getByRole('button', { name: /恢复上层/ }).click(); await expect(lookRow.getByRole('button', { name: /恢复上层/ })).toHaveCount(0);
    sent = fake.writes.slice(n).filter(w => w.path.endsWith('/overrides')); assert.equal(sent.length, 2, '只重发一次');
    assert.deepEqual(sent[1].body, sent[0].body, '重发必须是原编号、原内容'); assert.deepEqual(fake.receiptReads, [sent[0].body.request_id]);
  });

  await check('返工·全剧视图的「人物属性维度」改全剧配置：剧作用域删除预览含集里单独改的分，保存带请求号和令牌', async () => {
    await switchTo('全剧'); await expect(list()).toHaveAttribute('aria-busy', 'false');
    await work().getByRole('button', { name: '更多资产操作' }).click(); await work().getByRole('menuitem', { name: '人物属性维度…' }).click();
    const dlg = page.getByRole('dialog', { name: '人物属性维度' }); await expect(dlg).toContainText('全剧「穿越计」'); await expect(dlg).toContainText('所有集共用');
    await dlg.getByRole('button', { name: '删除名望' }).click(); await dlg.getByRole('button', { name: '保存配置' }).click();
    await expect(dlg).toContainText('另有 2 处集里单独改的分会一并删除'); await dlg.getByRole('button', { name: '确认删除并保存' }).click(); await expect(dlg).toHaveCount(0);
    const pv = fake.writes.filter(w => w.path.endsWith('/removal-preview')).at(-1);
    assert.equal(pv.path, `/api/project-assets/scopes/series/${s.id}/attribute-config/removal-preview`); assert.equal(pv.body.context_token, 'ctx-token'); assert.deepEqual(pv.body.remove, ['d-3']);
    const save = fake.writes.filter(w => w.method === 'PATCH' && w.path.endsWith('/attribute-config')).at(-1);
    assert.equal(save.path, `/api/project-assets/scopes/series/${s.id}/attribute-config`); assert.equal(save.body.removal_confirmation.token, 'a'.repeat(64));
    assert.match(save.body.request_id, /^[0-9a-f-]{36}$/); assert.equal(save.body.context_token, 'ctx-token'); assert.equal(save.body.dimensions.length, 3);
  });

  await check('返工·有未保存修改时：解绑图片不进影响预览；切公共人物库取消后仍留在全剧', async () => {
    await list().locator('.ca-card').filter({ has: page.locator('strong', { hasText: /^李四$/ }) }).first().click(); await expect(work().locator('.ca-name-input')).toHaveValue('李四');
    const info = work().getByLabel('基础信息', { exact: true }), was = await info.inputValue(); await info.fill(was + '（未保存）');
    await work().getByRole('navigation', { name: '详情分区' }).getByRole('button', { name: '造型与参考图', exact: true }).click();
    await work().locator('.ca-look-list button').filter({ hasText: '囚服' }).click();
    const n = fake.writes.length; await work().getByRole('button', { name: /^设置参考图片：/ }).first().click();
    await page.getByRole('button', { name: '解绑归档' }).click(); await expect(page.getByText(/未保存的修改/).first()).toBeVisible();
    assert.equal(fake.writes.slice(n).filter(w => w.path.endsWith('/archive-impact')).length, 0, '有草稿时不应发影响预览');
    page.once('dialog', d => d.dismiss()); await switchTo('公共人物库');
    await expect(scopeSwitch().getByRole('button', { name: '全剧', exact: true })).toHaveAttribute('aria-pressed', 'true'); await expect(info).toHaveValue(was + '（未保存）');
    await info.fill(was); await expect(work().getByRole('button', { name: '保存资料', exact: true })).toBeDisabled();
  });

  await check('返工·全剧共享资产已归档：不显示会走旧接口的「恢复」，说明这一版不能恢复', async () => {
    const wang = fake.shared.find(x => x.asset.name === '王五'); wang.asset = { ...wang.asset, archived_at: Date.now() };
    await work().getByRole('button', { name: '刷新列表' }).click().catch(() => {}); await card('王五').click(); await expect(work().locator('.ca-name-input')).toHaveValue('王五');
    await expect(work().locator('.ca-archive-note')).toContainText('这一版还不能在页面里恢复');
    await work().getByRole('button', { name: '资料操作', exact: true }).click(); await expect(work().getByRole('menuitem', { name: '恢复' })).toHaveCount(0);
    await page.keyboard.press('Escape'); wang.asset = { ...wang.asset, archived_at: null };
  });

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const fileInput = () => work().locator('input[type=file][aria-label="选择一张参考图片"]');
  await check('返工·全剧视图从本地文件导入：上传到剧（series_context_token），保存后才绑定', async () => {
    await list().locator('.ca-card').filter({ has: page.locator('strong', { hasText: /^李四$/ }) }).first().click(); await expect(work().locator('.ca-name-input')).toHaveValue('李四');
    await work().getByRole('navigation', { name: '详情分区' }).getByRole('button', { name: '造型与参考图', exact: true }).click();
    await work().locator('.ca-look-list button').filter({ hasText: '囚服' }).click();
    await fileInput().setInputFiles({ name: '全剧新图.png', mimeType: 'image/png', buffer: png });
    await expect(work().getByRole('button', { name: '设置参考图片：全剧新图.png' })).toBeVisible();
    const u = fake.upload; assert.deepEqual({ p: u.projectId, a: u.assetId, l: u.lookId, t: u.series_context_token, e: 'append_context_token' in u }, { p: s.id, a: lisi.id, l: 'look-b', t: 'ctx-token', e: false });
    const n = fake.writes.length; await work().getByRole('button', { name: '保存资料', exact: true }).click(); await expect(work().getByRole('button', { name: '保存资料', exact: true })).toBeDisabled();
    const w = fake.writes.slice(n).find(x => x.method === 'PUT'); assert.equal(w.path, `/api/project-assets/scopes/series/${s.id}/assets/${lisi.id}`);
    assert.ok(w.body.asset.images.some(b => b.media_asset_id === 'media-up-' + fake.uploads.length && b.look_id === 'look-b'), '保存内容应含刚上传的图片');
  });

  await check('返工·集里从本地文件追加：上传到本集（append_context_token），再走回执、预览和确认', async () => {
    await scopeSwitch().getByRole('button').first().click(); await expect(list()).toHaveAttribute('aria-busy', 'false');
    await list().locator('.ca-card').filter({ has: page.locator('strong', { hasText: /^李四$/ }) }).first().click(); await expect(work().locator('.ca-scope-lock')).toBeVisible();
    await work().getByRole('navigation', { name: '详情分区' }).getByRole('button', { name: '造型与参考图', exact: true }).click();
    await work().locator('.ca-look-list button').filter({ hasText: '囚服' }).click();
    await fileInput().setInputFiles({ name: '本集新图.png', mimeType: 'image/png', buffer: png });
    const confirm = page.getByRole('dialog', { name: '确认追加图片' }); await expect(confirm).toBeVisible();
    const u = fake.upload; assert.deepEqual({ p: u.projectId, l: u.lookId, t: u.append_context_token, e: 'series_context_token' in u }, { p: eps[0].id, l: 'look-b', t: 'ctx-token', e: false });
    const rc = fake.writes.filter(w => w.path.endsWith('/append/media-receipt')).at(-1); assert.equal(rc.body.media_asset_id, 'media-up-' + fake.uploads.length); assert.equal(rc.body.look_id, 'look-b');
    await confirm.getByRole('button', { name: '确认追加' }).click(); await expect(confirm).toHaveCount(0);
    assert.equal(fake.writes.filter(w => w.path.endsWith('/append')).at(-1).path, `/api/project-assets/scopes/episode/${eps[0].id}/assets/${lisi.id}/append`);
  });

  await check('返工·项目目录季菜单「本季设定…」：打开资产页的本季设定，写入带来源集', async () => {
    await nav('项目'); await page.locator('.pf-card.pf-folder').filter({ hasText: '穿越计' }).first().click();
    await page.locator('.pf-card.pf-folder').filter({ hasText: '第 1 季' }).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: '本季设定…' }).click();
    await expect(seasonDlg()).toBeVisible(); await expect(page.getByRole('region', { name: '项目资产库' })).toBeVisible();
    await seasonDlg().getByRole('button', { name: '关闭' }).click(); await expect(seasonDlg()).toHaveCount(0);
  });

  await check('项目不在任何剧里：没有「全剧」，按原接口读取', async () => {
    const before = seen.length;
    await projectInBar(page).getByRole('navigation', { name: '当前项目' }).getByRole('button').first().click();
    await projectInBar(page).locator(`.ppb-option[data-target-project="${solo.id}"]`).first().click(); await expect(projectInBar(page)).toHaveAttribute('data-project', solo.id);
    await settled(['短片主角']); await expect(scopeSwitch().getByRole('button', { name: '全剧', exact: true })).toHaveCount(0);
    await expect(list().locator('.ca-owner-src')).toHaveCount(0);
    assert.ok(!seen.slice(before).some(p => p.startsWith('/api/project-assets/scopes/')), '未归剧时不走作用域列表');
  });

  await check('后端还没有作用域接口（404 或回网页本身）：保持原有行为，不报错', async () => {
    fake.mode = 'missing'; await pickEpisodeFromSeries();
    await expect(list()).toHaveAttribute('aria-busy', 'false'); await expect.poll(async () => (await cards().allTextContents()).sort()).toEqual(['卖油郎', '李四']); // 原接口按最近修改排序
    await expect(scopeSwitch().getByRole('button', { name: '全剧', exact: true })).toHaveCount(0);
    await expect(list().locator('.ca-owner-src')).toHaveCount(0); await expect(work().getByRole('alert')).toHaveCount(0);
    // 旧后端对未知路径回网页本身（200 + HTML）：同样保持原样、不提示错误
    fake.mode = 'html'; await page.reload(); await nav('项目资产');
    await expect(list()).toHaveAttribute('aria-busy', 'false'); await expect.poll(async () => (await cards().allTextContents()).sort()).toEqual(['卖油郎', '李四']);
    await expect(scopeSwitch().getByRole('button', { name: '全剧', exact: true })).toHaveCount(0); await expect(work().getByRole('alert')).toHaveCount(0);
    fake.mode = 'contract';
  });
  async function pickEpisodeFromSeries() {
    await projectInBar(page).getByRole('navigation', { name: '当前项目' }).getByRole('button').first().click();
    await projectInBar(page).locator('.ppb-option').filter({ hasText: '穿越计' }).first().click();
    await expect(projectInBar(page)).toHaveAttribute('data-project', new RegExp(eps.map(e => e.id).join('|')));
    if (await projectInBar(page).getAttribute('data-project') !== eps[0].id) await page.getByRole('button', { name: '上一集：第1集' }).click();
    await expect(projectInBar(page)).toHaveAttribute('data-project', eps[0].id);
  }

  assert.deepEqual(errors, [], '页面不应出现脚本错误');
  passed = true;
} finally {
  if (!passed) { console.error(logs.slice(-2000)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'creative-assets-scope-failure.png') }).catch(() => {}); }
  await browser?.close(); child.kill('SIGTERM'); let timer; if (await Promise.race([exited, new Promise(r => timer = setTimeout(() => r('timeout'), 10000))]) === 'timeout') { child.kill('SIGKILL'); await exited; } clearTimeout(timer);
  await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
