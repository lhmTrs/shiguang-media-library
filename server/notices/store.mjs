// 待处理：后台任务结果通知，可以拍板、已读、稍后。设计见 NOTICES.md。
// 只有用户能做决定（PATCH …/decision，仅页面）；AI 和后台程序只能放卡片、读决定、回报执行结果。
// 点「重做」只记下决定，不执行任何要花钱的动作；执行方读到决定后自己去做，再回报结果。
import {randomUUID} from 'node:crypto';
import {ensureNoticeSchema} from './schema.mjs';

export const NOTICE_SCHEMA_VERSION = 1;
export const KINDS = ['decision', 'info'];
export const STATUSES = ['open', 'later', 'redo_decided', 'running', 'done', 'failed', 'skipped', 'read', 'resolved'];
export const ENDED = new Set(['done', 'failed', 'skipped', 'read', 'resolved']);
export const STATUS_LABEL = {
  open: '等你处理', later: '稍后', redo_decided: '已决定重做', running: '执行中', done: '完成', failed: '又失败',
  skipped: '知道了，不重做', read: '已读', resolved: '来源已处理',
};
// 页面能跳去的地方：和 src/browser-preferences.ts 的 viewPaths 对应，只收这几个。
export const LINK_VIEWS = ['projectMusic', 'projectVideos', 'storyboard', 'projectAssets', 'projects', 'projectUsage', 'promptTemplates'];
const SOURCE_LABEL = {updream: 'Updream 跟进器', 'project-music': '项目音乐'};
const POST_FIELDS = ['source', 'key', 'kind', 'typeLabel', 'title', 'context', 'costNote', 'owner', 'links', 'occurredAt', 'sourceLabel', 'session'];
const RESULT_FIELDS = ['state', 'note', 'session', 'next'];
const NEXT_FIELDS = ['typeLabel', 'title', 'context', 'costNote'];
const DECISION_FIELDS = ['action', 'expectedRevision', 'costAcknowledged'];
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const HISTORY_MAX = 40;
const ENDED_DEFAULT = 50;
const SYNC_INTERVAL = 2000;

const fault = (code, message, status = 400, details) => Object.assign(Error(message), {status, code, ...(details ? {details} : {})});
const fail = (...args) => { throw fault(...args); };
const idOK = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

function text(value, label, max, {required = false, multiline = false} = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail('INVALID_INPUT', `请填写${label}`);
    return '';
  }
  if (typeof value !== 'string' || value.length > max || CONTROL.test(value)) fail('INVALID_INPUT', `${label}格式无效，最多 ${max} 字`);
  const v = value.replace(/\r\n/g, '\n').trim();
  if (required && !v) fail('INVALID_INPUT', `请填写${label}`);
  if (!multiline && /[\n\t]/.test(v)) fail('INVALID_INPUT', `${label}不能换行`);
  return v.normalize('NFC');
}

function onlyKeys(input, allowed, what = '请求') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT', `${what}必须是 JSON 对象`);
  const extra = Object.keys(input).filter(k => !allowed.includes(k));
  if (extra.length) fail('FIELD_NOT_ALLOWED', `${what}包含不支持的字段：${extra.join('、')}`, 400, {fields: extra});
  return input;
}

function source(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{1,39}$/.test(value)) fail('INVALID_SOURCE', '来源（source）要用小写字母、数字和连字符，2 到 40 个字符，例如 updream');
  return value;
}

function key(value) {
  const v = text(value, '原编号（key）', 160, {required: true});
  return v;
}

function owner(value) {
  if (value === undefined || value === null) return null;
  onlyKeys(value, ['session', 'id', 'gone'], 'owner');
  const session = text(value.session, '负责的会话名（owner.session）', 60);
  const id = text(value.id, '负责的会话编号（owner.id）', 80);
  if (value.gone !== undefined && typeof value.gone !== 'boolean') fail('INVALID_INPUT', 'owner.gone 只能是 true 或 false');
  if (!session && !id) return null;
  return {session: session || null, id: id || null, gone: value.gone === true};
}

function links(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 4) fail('INVALID_INPUT', 'links 最多 4 条');
  return value.map(l => {
    onlyKeys(l, ['label', 'view', 'projectId'], 'links 里的一条');
    const label = text(l.label, '链接文字', 20, {required: true});
    if (!LINK_VIEWS.includes(l.view)) fail('INVALID_LINK', `链接的 view 只能是：${LINK_VIEWS.join('、')}`);
    if (l.projectId !== undefined && l.projectId !== null && !idOK(l.projectId)) fail('INVALID_LINK', '链接的 projectId 无效');
    return {label, view: l.view, projectId: l.projectId ? l.projectId.toLowerCase() : null};
  });
}

function occurredAt(value, now) {
  if (value === undefined || value === null) return now;
  if (!Number.isSafeInteger(value) || value < Date.UTC(2020, 0, 1) || value > now + 86_400_000) fail('INVALID_INPUT', 'occurredAt 要用 UTC 毫秒，不能早于 2020 年，也不能是明天以后');
  return value;
}

function session(value, required = true) {
  return text(value, '会话名（session）', 60, {required}) || null;
}

const parse = row => row && ({...row, attempt: Number(row.attempt), revision: Number(row.revision), created_at: Number(row.created_at), updated_at: Number(row.updated_at), data: JSON.parse(row.data_json)});
const pushHistory = (data, entry) => { data.history = [...(data.history ?? []), entry].slice(-HISTORY_MAX); };

export class Notices {
  constructor({lib, now = () => Date.now()}) {
    this.lib = lib;
    this.now = now;
    this.sources = new Map();
    this.syncedAt = 0;
  }

  get db() { return this.lib.db; }

  init() {
    ensureNoticeSchema(this.db);
    return this;
  }

  // ---------- 内置来源（例如项目音乐「待 AI 补写」）：读的时候对一次，清单里没有了就自动结掉 ----------

  /** list() 返回当前所有条目 [{key, kind, typeLabel, title, context?, owner?, links?, occurredAt?}]；gone(key) 返回结掉时显示的一句话。 */
  registerSource(name, {label, list, gone = () => '来源那边已经处理了'}) {
    source(name);
    this.sources.set(name, {label, list, gone});
    this.syncedAt = 0;
    return this;
  }

  sync({force = false} = {}) {
    const now = this.now();
    if (!force && now - this.syncedAt < SYNC_INTERVAL) return;
    this.syncedAt = now;
    for (const [name, provider] of this.sources) {
      try {
        const items = provider.list();
        const keys = new Set();
        for (const item of items) {
          keys.add(item.key);
          // 一条出错只跳过这一条，不影响别的条目，也不会因此把它当成「已经处理了」结掉。
          try { this.upsert({...item, source: name, sourceLabel: provider.label, session: provider.label}, {internal: true}); }
          catch (e) { console.warn(`[notices] 来源 ${name} 的 ${item.key} 没能放进待处理：`, e.message); }
        }
        const open = this.db.prepare('SELECT * FROM notices WHERE source=? ORDER BY created_at,id').all(name).map(parse).filter(r => !ENDED.has(r.status));
        for (const row of open) if (!keys.has(row.source_key)) this.resolve(row, provider.gone(row.source_key));
      } catch (e) {
        console.warn(`[notices] 来源 ${name} 没能同步：`, e.message);
      }
    }
  }

  resolve(row, note) {
    const at = this.now(), data = {...row.data, resolution: {at, note: String(note).slice(0, 200)}};
    pushHistory(data, {at, event: 'resolved', by: 'source', note: data.resolution.note});
    this.write(row, 'resolved', data, at);
  }

  // ---------- 放卡片（AI、后台程序；带 x-local-token） ----------

  post(input) {
    onlyKeys(input, POST_FIELDS);
    if (this.sources.has(input.source)) fail('SOURCE_RESERVED', `「${input.source}」是拾光内置的来源，由拾光自己放卡片`, 403);
    return this.upsert(input, {internal: false});
  }

  upsert(input, {internal}) {
    const now = this.now();
    const src = source(input.source), k = key(input.key);
    if (!KINDS.includes(input.kind)) fail('INVALID_KIND', 'kind 只能是 decision（要用户拍板）或 info（只是告知）');
    const content = {
      typeLabel: text(input.typeLabel, '类型标签（typeLabel）', 40, {required: true}),
      title: text(input.title, '标题', 120, {required: true}),
      context: text(input.context, '补充说明（context）', 1000, {multiline: true}) || null,
      costNote: text(input.costNote, '花费说明（costNote）', 80) || null,
      owner: owner(input.owner),
      links: links(input.links),
      sourceLabel: text(input.sourceLabel, '来源名（sourceLabel）', 30) || SOURCE_LABEL[src] || src,
    };
    const by = internal ? input.session : session(input.session);
    const when = occurredAt(input.occurredAt, now);
    return this.db.transaction(() => {
      const latest = this.latest(src, k);
      if (!latest) {
        const id = randomUUID();
        const data = {...content, occurredAt: when, postedBy: by, decision: null, result: null, resolution: null, previousId: null, nextId: null, history: []};
        pushHistory(data, {at: now, event: 'posted', by});
        this.db.prepare('INSERT INTO notices(id,source,source_key,attempt,kind,status,data_json,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(id, src, k, 1, input.kind, 'open', JSON.stringify(data), 1, now, now);
        return {notice: this.dto(this.row(id)), created: true, updated: false};
      }
      // 结束了的卡不再改：用户已经处理过，再放一次同一个编号不会让它重新挂起来。真有新情况请换一个原编号。
      if (ENDED.has(latest.status)) return {notice: this.dto(latest), created: false, updated: false, ended: true};
      if (latest.kind !== input.kind) fail('KIND_MISMATCH', `这张卡已经是「${latest.kind === 'decision' ? '要你拍板' : '只是告知'}」，不能改成另一种`, 409);
      const before = latest.data;
      const changed = Object.keys(content).filter(f => JSON.stringify(before[f] ?? null) !== JSON.stringify(content[f] ?? null));
      // 内置来源的发生时间以来源为准；外部来源再放一次时，保留第一次的发生时间（已经挂了几天不因重放而清零）。
      const keepWhen = internal && input.occurredAt ? when : before.occurredAt;
      if (!changed.length && keepWhen === before.occurredAt) return {notice: this.dto(latest), created: false, updated: false};
      const data = {...before, ...content, occurredAt: keepWhen};
      pushHistory(data, {at: now, event: 'updated', by, note: changed.join(',')});
      this.write(latest, latest.status, data, now);
      return {notice: this.dto(this.row(latest.id)), created: false, updated: true};
    })();
  }

  // ---------- 用户做决定（仅页面） ----------

  decide(id, input) {
    onlyKeys(input, DECISION_FIELDS);
    const {action} = input;
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) fail('INVALID_REVISION', '请提供 expectedRevision');
    const now = this.now();
    return this.db.transaction(() => {
      const row = this.get(id);
      if (row.revision !== input.expectedRevision) fail('REVISION_CONFLICT', '这张卡刚刚有了变化，请看一眼最新的内容再决定', 409, {notice: this.dto(row)});
      const allowed = row.kind === 'decision' ? ['redo', 'skip', 'later'] : ['read'];
      if (!allowed.includes(action)) fail('ACTION_NOT_ALLOWED', row.kind === 'decision' ? '要你拍板的卡只能选：重做、知道了不重做、稍后' : '只是告知的卡只能点「已读」');
      const from = row.kind === 'decision' ? (action === 'later' ? ['open'] : ['open', 'later']) : ['open'];
      if (!from.includes(row.status)) fail('ALREADY_DECIDED', `这张卡现在是「${STATUS_LABEL[row.status]}」，不能再这样改`, 409, {notice: this.dto(row)});
      if (action === 'redo' && input.costAcknowledged !== true) fail('COST_NOT_ACKNOWLEDGED', '重做前要先在确认框里看过花费', 400);
      const next = {redo: 'redo_decided', skip: 'skipped', later: 'later', read: 'read'}[action];
      const data = {...row.data, decision: {action, at: now, by: 'user'}};
      pushHistory(data, {at: now, event: 'decided', by: 'user', note: action});
      this.write(row, next, data, now);
      return {notice: this.dto(this.row(row.id))};
    })();
  }

  // ---------- 执行方回报结果（只对用户已决定重做的卡） ----------

  report(id, input) {
    onlyKeys(input, RESULT_FIELDS);
    const state = input.state;
    if (!['running', 'done', 'failed'].includes(state)) fail('INVALID_STATE', 'state 只能是 running（开始执行）、done（完成）或 failed（又失败）');
    const by = session(input.session);
    const note = text(input.note, '结果说明（note）', 500, {multiline: true}) || null;
    let next = null;
    if (input.next !== undefined && input.next !== null) {
      onlyKeys(input.next, NEXT_FIELDS, 'next');
      next = {
        typeLabel: text(input.next.typeLabel, 'next.typeLabel', 40) || null,
        title: text(input.next.title, 'next.title', 120) || null,
        context: text(input.next.context, 'next.context', 1000, {multiline: true}) || null,
        costNote: text(input.next.costNote, 'next.costNote', 80) || null,
      };
    }
    if (next && state !== 'failed') fail('INVALID_INPUT', '只有 state=failed 时才能带 next（新卡的内容）');
    const now = this.now();
    return this.db.transaction(() => {
      const row = this.get(id);
      // 同一个结果再报一次：照原样返回，不重复开新卡。
      if (row.status === state) return {notice: this.dto(row), next: row.data.nextId ? this.dto(this.row(row.data.nextId)) : null, repeated: true};
      const from = state === 'running' ? ['redo_decided'] : ['redo_decided', 'running'];
      if (!from.includes(row.status)) {
        const why = row.status === 'open' || row.status === 'later' ? '用户还没决定重做，不能执行' : `这张卡现在是「${STATUS_LABEL[row.status]}」`;
        fail('NOT_REDO_DECIDED', `${why}；只有用户在页面上点了「重做」的卡才能回报执行结果`, 409, {notice: this.dto(row)});
      }
      const data = {...row.data, result: {state, at: now, by, note}};
      pushHistory(data, {at: now, event: state, by, note: note ?? undefined});
      let created = null;
      if (state === 'failed') {
        // 又失败：原卡结束，另开一张新卡（attempt+1），不在原卡上循环。
        const newId = randomUUID(), old = row.data;
        const fresh = {
          typeLabel: next?.typeLabel ?? '重做后又失败', title: next?.title ?? old.title,
          context: next?.context ?? note ?? old.context ?? null, costNote: next?.costNote ?? old.costNote ?? null,
          owner: old.owner ?? null, links: old.links ?? [], sourceLabel: old.sourceLabel,
          occurredAt: now, postedBy: by, decision: null, result: null, resolution: null, previousId: row.id, nextId: null, history: [],
        };
        pushHistory(fresh, {at: now, event: 'posted', by, note: `第 ${row.attempt} 次的重做又失败了`});
        this.db.prepare('INSERT INTO notices(id,source,source_key,attempt,kind,status,data_json,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(newId, row.source, row.source_key, row.attempt + 1, 'decision', 'open', JSON.stringify(fresh), 1, now, now);
        data.nextId = newId;
        created = newId;
      }
      this.write(row, state, data, now);
      return {notice: this.dto(this.row(row.id)), next: created ? this.dto(this.row(created)) : null};
    })();
  }

  // ---------- 读取 ----------

  row(id) { return parse(this.db.prepare('SELECT * FROM notices WHERE id=?').get(id)); }

  get(id) {
    if (!idOK(id)) fail('NOTICE_NOT_FOUND', '卡片编号无效', 404);
    const row = this.row(id.toLowerCase());
    if (!row) fail('NOTICE_NOT_FOUND', '没有找到这张卡', 404);
    return row;
  }

  latest(src, k) {
    return parse(this.db.prepare('SELECT * FROM notices WHERE source=? AND source_key=? ORDER BY attempt DESC LIMIT 1').get(src, k));
  }

  write(row, status, data, at) {
    const result = this.db.prepare('UPDATE notices SET status=?,data_json=?,revision=?,updated_at=? WHERE id=? AND revision=?')
      .run(status, JSON.stringify(data), row.revision + 1, at, row.id, row.revision);
    if (Number(result.changes) !== 1) fail('REVISION_CONFLICT', '这张卡刚刚有了变化，请重试', 409);
  }

  one(id) {
    this.sync();
    return {notice: this.dto(this.get(id))};
  }

  summary() {
    const counts = Object.fromEntries(this.db.prepare('SELECT kind,status,COUNT(*) n FROM notices GROUP BY kind,status').all().map(r => [`${r.kind}:${r.status}`, Number(r.n)]));
    const n = (...keys) => keys.reduce((s, k) => s + (counts[k] ?? 0), 0);
    return {
      // 顶栏「待处理 N」：只算要你拍板、还没处理的；点过「稍后」的不算。
      pending: n('decision:open'),
      info: n('info:open'),
      later: n('decision:later'),
      inflight: n('decision:redo_decided', 'decision:running'),
      ended: [...ENDED].reduce((s, st) => s + n(`decision:${st}`, `info:${st}`), 0),
    };
  }

  /** 默认：所有没结束的卡 + 最近结束的 50 张。也可以按 status / source / key 筛。 */
  list(query = {}) {
    this.sync();
    const where = [], args = [];
    if (query.source !== undefined) { where.push('source=?'); args.push(source(query.source)); }
    if (query.key !== undefined) { where.push('source_key=?'); args.push(key(query.key)); }
    let statuses = null;
    if (query.status !== undefined && query.status !== '') {
      statuses = String(query.status).split(',').map(s => s.trim()).filter(Boolean);
      const bad = statuses.filter(s => !STATUSES.includes(s) && s !== 'ended' && s !== 'active');
      if (bad.length) fail('INVALID_STATUS', `status 只能是 ${STATUSES.join('、')}，或 active（没结束的）、ended（已结束的）`);
      statuses = [...new Set(statuses.flatMap(s => s === 'ended' ? [...ENDED] : s === 'active' ? STATUSES.filter(x => !ENDED.has(x)) : [s]))];
    }
    const endedLimit = query.endedLimit === undefined ? ENDED_DEFAULT : Number(query.endedLimit);
    if (!Number.isSafeInteger(endedLimit) || endedLimit < 0 || endedLimit > 500) fail('INVALID_INPUT', 'endedLimit 是 0 到 500 的整数');
    const rows = this.db.prepare('SELECT * FROM notices' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY updated_at DESC,id').all(...args).map(parse)
      .filter(r => !statuses || statuses.includes(r.status));
    const active = rows.filter(r => !ENDED.has(r.status)).sort((a, b) => a.data.occurredAt - b.data.occurredAt || a.created_at - b.created_at);
    const ended = rows.filter(r => ENDED.has(r.status));
    return {
      schemaVersion: NOTICE_SCHEMA_VERSION, readAt: this.now(), summary: this.summary(),
      notices: [...active, ...ended.slice(0, endedLimit)].map(r => this.dto(r)), endedTotal: ended.length,
    };
  }

  group(row) {
    if (ENDED.has(row.status)) return 'ended';
    if (row.status === 'later') return 'later';
    return row.kind === 'decision' ? 'decision' : 'info';
  }

  dto(row) {
    const d = row.data;
    return {
      id: row.id, source: row.source, sourceLabel: d.sourceLabel, key: row.source_key, attempt: row.attempt,
      kind: row.kind, status: row.status, statusLabel: STATUS_LABEL[row.status], group: this.group(row),
      // 等你决定：只有要你拍板、还没决定（含稍后）的卡；页面据此显示按钮。
      awaitingUser: row.kind === 'decision' ? ['open', 'later'].includes(row.status) : row.status === 'open',
      typeLabel: d.typeLabel, title: d.title, context: d.context ?? null, costNote: d.costNote ?? null,
      owner: d.owner ?? null, unassigned: !d.owner || d.owner.gone === true, links: d.links ?? [],
      occurredAt: d.occurredAt, postedBy: d.postedBy ?? null, decision: d.decision ?? null, result: d.result ?? null, resolution: d.resolution ?? null,
      previousId: d.previousId ?? null, nextId: d.nextId ?? null, history: d.history ?? [],
      revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }
}
