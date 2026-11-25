// 剧本区前端测试用的假后端：按《剧本区接口合同 v1.1》的路由和形状，在内存里回包（经 Playwright page.route 接管）。
// 只给前端接线测试用；真正的校验、存储和幂等以 Codex 的后端为准。草稿正文走真服务的旧路由，这里只算摘要。
import crypto from 'node:crypto';
import { makeRenderData, readFixture, splitLines } from './make-render-data.mjs';

const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(body) });
const fail = (route, status, code, message, extra = {}) => json(route, status, { code, message, error: message, ...extra });
export const digestOf = (title, content) => crypto.createHash('sha256').update(JSON.stringify([title, content]), 'utf8').digest('hex');
const page = (items, url) => { const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 20); return { items: items.slice(offset, offset + limit), total: items.length, offset, limit }; };

/** 合成 422：四个反例按《核对结果.txt》各报一个问题。 */
const BAD = {
  fixture_bad_dup_key: [{ code: 'SOURCE_KEY_DUPLICATE', path: 'graph.sources[2].key', message: '来源 key 重复：V1', severity: 'error' }],
  fixture_bad_cross_side: [{ code: 'REF_WRONG_SIDE', path: 'graph.nodes[7].new[0].source', message: 'new 只能引 versions.v2 的来源', severity: 'error' }],
  fixture_bad_out_of_range: [{ code: 'REF_OUT_OF_RANGE', path: 'graph.nodes[3].new[0].start', message: '行号越界（共 14 行）', severity: 'error' }],
  fixture_bad_quote_off_by_one: [{ code: 'QUOTE_MISMATCH', path: 'graph.nodes[5].new[0].quote', message: 'quote 对不上 L10', severity: 'error', candidateLines: [9] }],
};
const badKind = graph => Object.keys(BAD).find(name => JSON.stringify(readFixture(name)) === JSON.stringify(graph));

export function createFakeBackend({ origin, cookie, libraryId, projectId, now = () => Date.now() }) {
  const t0 = now();
  const log = [];
  const state = {
    versions: [{ id: 'legacy-1', projectId, kind: 'legacy', versionNo: null, title: '迁移来的合成剧本', sourceId: 'src-legacy-1', draftRevision: 0, createdAt: t0 - 5 * 86_400_000, finalizedAt: null, content: '## 场一\n迁移时的合成正文。\n乙看向门口。' }],
    snapshots: [{ id: 'snap-1', projectId, kind: 'snapshot', title: '合成剧本', sourceId: 'fixture-a', draftRevision: 1, createdAt: t0 - 3600_000, content: '' }],
    maps: [], materials: [], receipts: new Map(), materialText: new Map(), materialBytes: new Map(),
  };
  // 一张草稿图（挂在快照上，标「基于较早的草稿」）和一张挂在迁移基线上的改动图
  const single = makeRenderData(readFixture('fixture_single'));
  state.maps.push({ map: { id: 'map-1', projectId, kind: 'single', title: single.graph.title, schemaVersion: 1, createdAt: t0 - 1800_000, binding: { target: { kind: 'snapshot', id: 'snap-1' } }, isDraftStale: true }, renderData: single, issues: [{ code: 'LABEL_LONG', path: 'graph.nodes[5].label', message: '标签超长', severity: 'warning' }] });
  const diff = makeRenderData(readFixture('fixture_diff'), { deleted: ['V1'] });
  state.maps.push({ map: { id: 'map-2', projectId, kind: 'diff', title: diff.graph.title, schemaVersion: 1, createdAt: t0 - 900_000, binding: { before: { kind: 'snapshot', id: 'snap-1' }, target: { kind: 'legacy', id: 'legacy-1' } }, isDraftStale: false }, renderData: diff, issues: [] });

  async function realDraft() {
    const r = await fetch(origin + '/api/project-assets/projects/' + projectId + '/script', { headers: { cookie } });
    const d = await r.json(); return { projectId, title: d.title, content: d.content, revision: d.revision, updatedAt: d.updated_at, contentDigest: digestOf(d.title, d.content) };
  }
  const summary = ({ content, ...v }) => v;

  async function handle(route) {
    const req = route.request(), url = new URL(req.url()), verb = req.method();
    const m = url.pathname.match(/^\/api\/project-scripts\/projects\/([^/]+)(\/.*)?$/);
    const headers = req.headers();
    log.push({ verb, path: url.pathname + url.search, libraryHeader: headers['x-shiguang-library-id'] ?? null, token: !!headers['x-local-token'], contentType: headers['content-type'] ?? null });
    if (!m) return fail(route, 404, 'SCRIPT_NOT_FOUND', '没有这个接口');
    // 合同 v1.1：只有浏览器直开的资料原件（GET/HEAD …/content）可以用地址里的 libraryId 代替请求头；两个都给就要一致。
    const content = ['GET', 'HEAD'].includes(verb) && /\/materials\/[^/]+\/content$/.test(url.pathname), q = content ? url.searchParams.get('libraryId') : null, h = headers['x-shiguang-library-id'];
    if (h && q && h !== q) return fail(route, 409, 'SCRIPT_SCOPE_CHANGED', '库身份不一致');
    if ((h ?? q) !== libraryId) return fail(route, 400, 'SCRIPT_INVALID_INPUT', '缺少库请求头');
    if (decodeURIComponent(m[1]) !== projectId) return fail(route, 404, 'SCRIPT_NOT_FOUND', '没有这个项目');
    if (verb !== 'GET' && !headers['x-local-token']) return fail(route, 403, 'LOCAL_FORBIDDEN', '本机会话校验失败');
    const rest = m[2] ?? '', body = verb === 'POST' && !String(headers['content-type'] ?? '').startsWith('multipart/') ? JSON.parse(req.postData() || '{}') : null;

    if (verb === 'GET' && rest === '/draft') return json(route, 200, await realDraft());
    if (verb === 'GET' && rest === '/versions') {
      const sorted = [...state.versions].sort((a, b) => (b.versionNo ?? -1) - (a.versionNo ?? -1));
      return json(route, 200, page(sorted.map(summary), url));
    }
    let x;
    if (verb === 'GET' && (x = rest.match(/^\/versions\/([^/]+)$/))) { const v = state.versions.find(v => v.id === x[1]); return v ? json(route, 200, v) : fail(route, 404, 'SCRIPT_NOT_FOUND', '没有这一版'); }
    if (verb === 'POST' && rest === '/versions') {
      const key = 'finalize:' + body.requestId, same = JSON.stringify([body.expected_revision, body.contentDigest]);
      const hit = state.receipts.get(key); if (hit) return hit.input === same ? json(route, 200, hit.body) : fail(route, 409, 'SCRIPT_REQUEST_CONFLICT', '同一个 requestId 参数不同');
      if (state.holdFinalize) { state.holdFinalize = false; return route.abort('timedout'); }
      const d = await realDraft();
      if (d.revision !== body.expected_revision || d.contentDigest !== body.contentDigest) return fail(route, 409, 'SCRIPT_DRAFT_CHANGED', '草稿已经变了', { details: { current_revision: d.revision, contentDigest: d.contentDigest, updatedAt: d.updatedAt } });
      if (!d.content.trim()) return fail(route, 422, 'SCRIPT_DRAFT_EMPTY', '草稿是空的');
      const no = Math.max(0, ...state.versions.map(v => v.versionNo ?? 0)) + 1;
      const v = { id: 'ver-' + no, projectId, kind: 'version', versionNo: no, title: d.title, sourceId: 'src-ver-' + no, draftRevision: d.revision, createdAt: d.updatedAt, finalizedAt: now(), content: d.content };
      state.versions.push(v); const out = { version: summary(v) }; state.receipts.set(key, { input: same, body: out });
      return json(route, 201, out);
    }
    if (verb === 'GET' && rest === '/draft/snapshots') return json(route, 200, page(state.snapshots.map(summary), url));
    if (verb === 'GET' && rest === '/maps') return json(route, 200, page(state.maps.map(x => x.map).sort((a, b) => b.createdAt - a.createdAt), url));
    if (verb === 'GET' && (x = rest.match(/^\/maps\/([^/]+)$/))) { const d = state.maps.find(e => e.map.id === x[1]); return d ? json(route, 200, d) : fail(route, 404, 'SCRIPT_NOT_FOUND', '没有这张图'); }
    if (verb === 'POST' && rest === '/maps/dry-run') {
      state.dryRuns = (state.dryRuns ?? 0) + 1;
      if (state.dryRunDelay) await new Promise(r => setTimeout(r, state.dryRunDelay(body)));
      const bad = badKind(body.graph);
      if (bad) return json(route, 422, { code: 'SCRIPT_MAP_INVALID', message: '泳道图校验没有通过', error: '泳道图校验没有通过', issues: BAD[bad] });
      if (!body.graph || body.graph.schemaVersion !== 1) return json(route, 422, { code: 'SCRIPT_MAP_INVALID', message: '泳道图校验没有通过', error: '泳道图校验没有通过', issues: [{ code: 'SCHEMA_VERSION', path: 'graph.schemaVersion', message: '不认识的 schemaVersion', severity: 'error' }] });
      const rd = makeRenderData(body.graph);
      return json(route, 200, { renderData: { ...rd, binding: { target: { ...body.binding.target, versionNo: null, title: '合成', displayLabel: '试画目标', at: now() }, ...(body.binding.before ? { before: { ...body.binding.before, versionNo: null, title: '合成', displayLabel: '试画前稿', at: now() - 86_400_000 } } : {}) } }, issues: [{ code: 'BACKWARD_EDGE', path: 'graph.edges[0]', message: '合成提醒：箭头往回指', severity: 'warning' }] });
    }
    if (verb === 'GET' && rest.startsWith('/materials') && !rest.includes('/', 11)) {
      const scope = url.searchParams.get('scope') || 'all';
      const items = state.materials.filter(m => !m.deletedAt && (scope === 'all' || (scope === 'series' ? m.ownerType === 'series' : m.ownerType === 'project')));
      return json(route, 200, page(items.map(({ deletedAt, ...m }) => m).sort((a, b) => b.createdAt - a.createdAt), url));
    }
    if (verb === 'POST' && rest === '/materials') {
      const ct = headers['content-type'] ?? '', boundary = ct.match(/boundary=(.+)$/)?.[1];
      if (!ct.startsWith('multipart/form-data') || !boundary) return fail(route, 400, 'SCRIPT_INVALID_INPUT', '不是 multipart，或缺少边界');
      const raw = req.postDataBuffer().toString('latin1'), parts = raw.split('--' + boundary).slice(1, -1);
      const field = name => { const p = parts.find(p => p.includes(`name="${name}"`)); return p && p.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, ''); };
      const filePart = parts.find(p => p.includes('name="file"')), filename = Buffer.from(filePart.match(/filename="([^"]*)"/)[1], 'latin1').toString('utf8');
      const bytes = Buffer.from(field('file'), 'latin1'), ownerType = field('ownerType') || 'project', requestId = field('requestId');
      const hit = state.receipts.get('upload:' + requestId); if (hit) return json(route, 200, hit.body);
      if (!/\.(txt|docx|pdf)$/i.test(filename)) return fail(route, 415, 'SCRIPT_UNSUPPORTED_MEDIA', '不支持的文件类型');
      const id = 'mat-' + (state.materials.length + 1), txt = /\.txt$/i.test(filename);
      const mat = { id, projectId, ownerType, ownerId: ownerType === 'series' ? state.seriesId : projectId, originalFilename: filename, contentType: txt ? 'text/plain; charset=utf-8' : /\.pdf$/i.test(filename) ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', byteSize: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), createdAt: now(), updatedAt: now(), revision: 1, sourceId: txt ? 'src-' + id : null, downloadUrl: `/api/project-scripts/projects/${projectId}/materials/${id}/content?disposition=attachment&libraryId=${libraryId}`, previewUrl: /\.pdf$/i.test(filename) ? `/api/project-scripts/projects/${projectId}/materials/${id}/content?disposition=inline&libraryId=${libraryId}` : null };
      state.materials.push(mat); state.materialBytes.set(id, bytes); if (txt) state.materialText.set(mat.sourceId, bytes.toString('utf8'));
      const out = { material: mat }; state.receipts.set('upload:' + requestId, { body: out });
      return json(route, 201, out);
    }
    if (verb === 'POST' && (x = rest.match(/^\/materials\/([^/]+)\/(move|delete)$/))) {
      const mat = state.materials.find(m => m.id === x[1] && !m.deletedAt); if (!mat) return fail(route, 404, 'SCRIPT_NOT_FOUND', '没有这份资料');
      if (mat.revision !== body.expected_revision) return fail(route, 409, 'SCRIPT_MATERIAL_CHANGED', '资料已经变了', { details: { current_revision: mat.revision, ownerType: mat.ownerType, ownerId: mat.ownerId } });
      if (x[2] === 'move') { const previousOwner = { ownerType: mat.ownerType, ownerId: mat.ownerId }; Object.assign(mat, { ownerType: body.ownerType, ownerId: body.ownerId, revision: mat.revision + 1, updatedAt: now() }); return json(route, 200, { material: mat, previousOwner }); }
      mat.deletedAt = now(); return json(route, 200, { id: mat.id, deletedAt: mat.deletedAt, retainedExcerptCount: 2 });
    }
    if (verb === 'GET' && (x = rest.match(/^\/materials\/([^/]+)\/content$/))) {
      const mat = state.materials.find(m => m.id === x[1] && !m.deletedAt); if (!mat) return fail(route, 404, 'SCRIPT_NOT_FOUND', '没有这份资料');
      return route.fulfill({ status: 200, contentType: mat.contentType, body: state.materialBytes.get(mat.id) });
    }
    if (verb === 'GET' && (x = rest.match(/^\/sources\/([^/]+)$/))) {
      const text = state.materialText.get(decodeURIComponent(x[1])); if (text == null) return fail(route, 404, 'SCRIPT_NOT_FOUND', '没有这份来源');
      const lines = splitLines(text).map((t, i) => ({ number: i + 1, text: t })), offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 100);
      return json(route, 200, { id: x[1], kind: 'material', label: '甲方资料', extractorVersion: 'fake-1', sha256: '', lineCount: lines.length, lines: lines.slice(offset, offset + limit), total: lines.length, offset, limit });
    }
    return fail(route, 404, 'SCRIPT_NOT_FOUND', '假后端没有这个接口：' + verb + ' ' + rest);
  }
  return { handle, state, log };
}
