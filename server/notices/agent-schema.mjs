// GET /api/notices/schema：给 AI 和后台程序看的规则。详细说明见仓库里的 NOTICES.md。
import {LINK_VIEWS, STATUS_LABEL} from './store.mjs';

export const NOTICES_AGENT_SCHEMA = {
  version: '2026-11-21.2',
  what: '「待处理」：后台任务的结果放成卡片，用户在页面顶栏「待处理 N」里拍板或已读。卡片分两种：decision（要用户拍板：重做、知道了不重做、稍后）和 info（只是告知：已读）。',
  roles: [
    '只有用户能做决定：PATCH /api/notices/<id>/decision 要求浏览器自带的 Sec-Fetch-Site: same-origin，只接受网页发来的请求。AI 和后台程序不得伪造这个请求头，也不得调用这个接口；这条限制是防误用约定，不是技术上的安全边界。每次决定都会在卡片的 history 里记下请求来历（origin：User-Agent、Sec-Fetch-Site、Sec-Fetch-Mode、Sec-Fetch-Dest），事后能查出不是从页面点的决定。',
    'AI 和后台程序只能做三件事：放卡片（POST /api/notices）、读卡片和用户的决定（GET）、回报执行结果（POST /api/notices/<id>/result）。',
    '用户点「重做」只是记下决定，拾光不会执行任何东西，也不会花钱。负责的一方（例如 Updream 跟进器或负责的会话）读到 status=redo_decided 后自己去执行，开始时报 running，结束时报 done 或 failed。',
    '「稍后」不会自动提醒；卡片上只显示已经挂了几天，用户自己决定什么时候处理。不要因为卡片挂着就替用户做决定，也不要反复放同一张卡来催。',
  ],
  post: {
    request: 'POST /api/notices（带 x-local-token，和其他写接口一样）',
    body: {
      source: '来源，小写字母、数字、连字符，例如 updream',
      key: '来源那边的原编号，例如 job 编号；同一个 source+key 只有一张进行中的卡',
      kind: 'decision 或 info',
      typeLabel: '类型标签，最多 40 字，例如「生成失败 · 超时」',
      title: '标题，最多 120 字，例如「赤贫农夫养家计 · 56 集 · S2 镜」',
      context: '可选，补充说明，最多 1000 字，可换行',
      costNote: '可选，要花钱时写明，最多 80 字，例如「重做约花 1 次生成费」；decision 卡点「重做」时的确认框会显示它',
      owner: '可选，{session: 负责的会话名, id: 会话编号, gone: true|false}；不写或 gone=true 时页面标「待分派」',
      links: `可选，最多 4 条 {label: 最多 20 字, view: ${LINK_VIEWS.join(' | ')}, projectId?: 项目 UUID}，例如 {label: '看这镜', view: 'storyboard', projectId: '…'}`,
      occurredAt: '可选，事情发生的时间（UTC 毫秒），用来算已经挂了几天；不写就用现在',
      sourceLabel: '可选，页面上显示的来源名，最多 30 字；updream 默认显示「Updream 跟进器」',
      session: '必填，放卡片的会话名或程序名',
    },
    rules: [
      '同一个 source+key 再放一次：卡还没结束时只更新内容（标题、说明、花费、负责的会话、链接），不出第二张，状态和用户的决定不变，发生时间保留第一次的。返回 200 {created: false, updated: true|false}。',
      '同一个 source+key 的卡已经结束（用户已读、不重做、或重做完成/又失败）时，再放一次不会让它重新挂起来，返回 {created: false, ended: true} 和原卡。真有新情况（例如新的一次生成）请用新的原编号。',
      '第一次放返回 201 {created: true, notice}。',
      '负责的会话不在了：用同一个 source+key 再放一次，owner 写 {session: 原会话名, gone: true}；认领时写新的 owner。',
      'source=project-music 等拾光内置来源由拾光自己放，外部放会被拒绝：403 SOURCE_RESERVED。',
      '只放用户需要知道或需要拍板的结果；进度、日志不要放。标题和说明里不要放密钥、签名下载链接、本机绝对路径。',
    ],
    example: {
      source: 'updream', key: '<job 编号>', kind: 'decision', typeLabel: '生成失败 · 超时', title: '<项目> · <集> · <镜>',
      context: '平台返回任务执行超时', costNote: '重做约花 1 次生成费', owner: {session: '<负责的会话名>', id: 'local_…'},
      links: [{label: '看这镜', view: 'storyboard', projectId: '<项目 UUID>'}], occurredAt: 1763452800000, session: '<你的会话名或程序名>',
    },
  },
  read: {
    list: 'GET /api/notices → {summary, notices[], endedTotal}；默认是全部没结束的卡加最近结束的 50 张。可加 ?status=a,b（也可以写 active、ended）、?source=、?key=、?endedLimit=。',
    one: 'GET /api/notices/<id> → {notice}',
    summary: 'GET /api/notices/summary → {summary: {pending, info, later, inflight, ended}}；pending 就是顶栏的 N',
    findMine: '执行方找用户决定重做的卡：GET /api/notices?source=<你的来源>&status=redo_decided',
    statuses: STATUS_LABEL,
    fields: 'notice.status 是当前状态；notice.decision = {action: redo|skip|later|read, at, by: user}；notice.result = {state, at, by, note}；notice.nextId 是又失败后新开的那张卡；notice.history[] 是每一步的记录，用户做决定的那一条带 origin = {userAgent, fetchSite, fetchMode, fetchDest}。',
  },
  result: {
    request: 'POST /api/notices/<id>/result（带 x-local-token），body {state: running | done | failed, session: 必填, note?: 最多 500 字, next?: {typeLabel?, title?, context?, costNote?}}',
    rules: [
      '只能回报用户已经决定重做（status=redo_decided 或 running）的卡；用户还没决定时返回 409 NOT_REDO_DECIDED。',
      'running：开始执行。done：完成，卡片结束。failed：又失败，原卡结束，拾光另开一张新的 decision 卡（attempt+1，同一个 source+key），用户重新拍板；next 可以写新卡的类型标签、说明、花费，不写就沿用原卡并标「重做后又失败」。',
      '同一个结果再报一次（例如响应丢了重发）原样返回，不会重复开新卡。',
    ],
  },
};
