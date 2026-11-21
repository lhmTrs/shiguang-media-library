# 待处理（后台任务结果通知）

顶栏的「待处理 N」。后台任务的结果放成卡片，你看过就能结掉，不会一直挂着等人拍板。

## 你看到什么

- **顶栏「待处理 N」**：N 只算「要你拍板」并且还没处理的卡；点过「稍后」的不算。没有要拍板的事时只显示「待处理」。
- **右侧抽屉，分四组**：
  - **要你拍板**：按钮是「重做…」「知道了，不重做」「稍后」。已经决定重做、等执行方去做的卡也放在这一组下面的「已决定，等执行」里，不再显示按钮，也不计入 N。
  - **只是告知**：只有「已读」。
  - **稍后**：不会自动提醒，卡片上写着已经挂了几天。随时可以回来点「重做…」或「知道了，不重做」。
  - **已结束**：默认折叠。已读、不重做、重做完成、又失败、来源那边已经处理了的卡都在这里，历史一直保留（抽屉里列最近 50 张）。
- **每张卡片**：类型标签（例：生成失败 · 超时）、标题（例：项目 · 集 · 镜）、来源和负责的会话（负责的会话不在了或还没人负责时标「待分派」）、发生时间和已经挂了几天、要花钱时写明（例：重做约花 1 次生成费）、相关页面的链接（例：「看这镜」，会先切到那个项目）。
- **重做…**：先弹确认框，写清花费。框开着时来源改了这张卡（例如花费变了），点「确定重做」会被拒，框里换成最新的内容并说明变了，再看一眼确认才记下。确认后只是记下你的决定，拾光不会自己去执行，也不会花钱；由负责的一方去做，卡片依次显示「已决定重做 · 等执行 → 执行中 → 完成 / 又失败」。又失败会另开一张新卡，等你重新决定，不在原卡上循环。
- **外观**：新画风，变量和三套试用配色（纸张、工作室、画廊）和项目音乐共用，跟着项目音乐页上选的配色走（`shiguang.musicPalette.v1`）。顶栏入口沿用旧顶栏的样式。旧页面没有改。

## 规矩

- **只有你能做决定**：`PATCH /api/notices/:id/decision` 要求浏览器自带的 `Sec-Fetch-Site: same-origin`，做法和项目音乐「仅页面」的操作一样。AI 和后台程序只能放卡片、读决定、回报执行结果。页面和 AI 用的是同一种本机会话，刻意伪造请求头仍能绕过，所以这是防误用，不是安全边界。为了事后查得出来，每次决定都在卡片历史（`history`）那一条里记下请求来历 `origin`：`userAgent`（截到 200 字）、`fetchSite`、`fetchMode`、`fetchDest`。浏览器点的通常是 `same-origin / cors / empty` 加浏览器的 User-Agent；只伪造了 `Sec-Fetch-Site` 的程序请求，`fetchDest` 是空的，User-Agent 也不像浏览器。只记录，不参与判断；被拒绝的请求不改卡片，也不留记录。
- **同一件事只有一张卡**：放卡片时带「来源 + 原编号」（`source` + `key`，例：`updream` + job 编号）。卡还没结束时，同一个编号再放一次只更新原卡（标题、说明、花费、负责的会话、链接），状态和你的决定不变，发生时间保留第一次的。卡已经结束时，再放一次不会让它重新挂起来；真有新情况要用新的原编号。
- **负责的会话不在了**：放卡片的一方用同一个编号再放一次，`owner.gone = true`，页面标「待分派」，由项目总监或开发统筹认领（认领就是再放一次，写新的 owner）。
- **拾光内置的来源**（目前是 `project-music`）由拾光自己放卡，外部放会被拒绝（403 `SOURCE_RESERVED`）。

## 接口

都在 `/api/notices` 之下，沿用全站的本机地址、会话 Cookie 和写令牌（`x-local-token`）校验。给 AI 看的完整规则：`GET /api/notices/schema`；项目使用说明里也有一行入口。

| 用途 | 请求 | 谁用 |
| --- | --- | --- |
| 放卡片 | `POST /api/notices`，body `{source, key, kind: decision\|info, typeLabel, title, context?, costNote?, owner?: {session, id?, gone?}, links?: [{label, view, projectId?}], occurredAt?, sourceLabel?, session}` → 第一次 201 `{created: true, notice}`；再放 200 `{created: false, updated}`；已结束 200 `{created: false, ended: true}` | AI、后台程序 |
| 列表 | `GET /api/notices`（默认：没结束的全部 + 最近结束的 50 张），可加 `?status=a,b`（也可写 `active`、`ended`）、`?source=`、`?key=`、`?endedLimit=0..500` → `{schemaVersion, readAt, summary, notices, endedTotal}` | 页面、AI |
| 一张卡 | `GET /api/notices/:id` → `{notice}` | 页面、AI |
| 顶栏数字 | `GET /api/notices/summary` → `{summary: {pending, info, later, inflight, ended}}`，`pending` 就是 N | 页面 |
| 做决定 | `PATCH /api/notices/:id/decision {action: redo\|skip\|later\|read, expectedRevision, costAcknowledged?}`（**仅页面**；重做要 `costAcknowledged: true`，表示确认框里看过花费） | 只有用户 |
| 回报执行结果 | `POST /api/notices/:id/result {state: running\|done\|failed, session, note?, next?: {typeLabel?, title?, context?, costNote?}}` → `{notice, next}`；`failed` 时 `next` 是新开的卡 | 执行方 |

- `links[].view` 只能是 `projectMusic`、`projectVideos`、`storyboard`、`projectAssets`、`projects`、`projectUsage`、`promptTemplates`，页面据此切项目和页面；不收外部网址。
- 状态：`open`（等你处理）、`later`（稍后）、`redo_decided`（已决定重做）、`running`（执行中）；结束的有 `done`、`failed`、`skipped`、`read`、`resolved`（来源已处理）。
- 错误码：`PAGE_ONLY`（403，不是页面发来的决定）、`REVISION_CONFLICT`（409，带回最新的卡）、`ALREADY_DECIDED`（409）、`ACTION_NOT_ALLOWED`、`COST_NOT_ACKNOWLEDGED`、`NOT_REDO_DECIDED`（409，用户还没决定重做时回报结果）、`KIND_MISMATCH`（409）、`SOURCE_RESERVED`（403）、`FIELD_NOT_ALLOWED`、`INVALID_*`。
- 回报结果是幂等的：同一个结果再报一次原样返回，不会重复开新卡。

### 执行方怎么接（例：Updream 跟进器，这次没有接，以后由 Codex 那边接）

1. 生成失败：`POST /api/notices`，`source: 'updream'`、`key: <job 编号>`、`kind: 'decision'`、`costNote: '重做约花 1 次生成费'`、`owner` 写负责的会话、`links` 写「看这镜」。生成完成想告诉用户时，用 `kind: 'info'`（可选）。
2. 定期 `GET /api/notices?source=updream&status=redo_decided` 找用户决定重做的卡；`skip`、`read` 的卡不要再动。
3. 开始重做时报 `running`，结束时报 `done` 或 `failed`。又失败时拾光自动开新卡，不要自己再 POST 一张。
4. 新的一次生成（不是对同一张卡的重做）用新的 job 编号。

## 第一个来源：项目音乐「待 AI 补写」

从访达收纳开新一轮时，上一轮的「问题整理」「下一轮方向」等 AI 补写（见 PROJECT_MUSIC.md「待补写」清单）。拾光读待处理时（最多每 2 秒一次）对一遍这个清单：

- 清单里有的放成「只是告知」的卡，同一轮只一张，类型「待 AI 补写」，标题「项目 · 歌名 · 第 N 轮」，链接「看这首歌」。
- AI 补完了、清单里没有了，卡片自动结束，写「记录已经补完了」。
- 你点了「已读」，卡片结束；即使这一轮还没补完，也不会再挂回来。

## 数据

- **新表 `notices`**（SQLite、MySQL 共用一份定义，见 `server/notices/schema.mjs`）：`id`、`source`、`source_key`、`attempt`、`kind`、`status`、`data_json`、`revision`、`created_at`、`updated_at`。`(source, source_key, attempt)` 唯一，`(status, updated_at)` 有索引。时间一律为 UTC 毫秒，业务字段在 `data_json` 里（含每一步的历史，最多 40 条）。
- **一次性迁移**：`server/mysql.mjs` 的 SQLite→MySQL 迁移清单已登记这张表，连同唯一约束和索引。
- **上线需要正式库加 1 张表**：服务启动时 `CREATE TABLE IF NOT EXISTS notices`，正式库加表要用户另外批准。

## 测试

全部只用合成数据和全新临时库。

```sh
node --test tests/notices.test.mjs   # 真实服务：放卡片、同编号只更新、只有页面能拍板、写令牌、重做只记决定、执行结果、又失败开新卡、已读、稍后不计数、项目音乐来源自动成卡和自动结束
node --test tests/notices-poll.test.mjs   # 轮询最多一条链（假定时器，已在 CI 里）
npm run build && node --test tests/notices-ui.mjs   # 真实应用界面，需要系统 Chrome；NOTICES_SHOTS=<目录> 时存截图
NOTICES_MYSQLD=/path/to/mysqld node tests/notices-mysql.mjs   # SQLite 与临时 mysqld 跑同一场景并对比，再验证一次性迁移
```

不带 `NOTICES_MYSQLD` 时，MySQL 对比脚本只跑 SQLite 一半，并以退出码 3 结束，不算通过。

## 尚未包含

- Updream 跟进器还没接（接口已经写清楚，见上面「执行方怎么接」）。
- 会话之间的等待、会话桥的已读回执（以后再加）。
- 来源那边自己解决了一张「要你拍板」的卡（例如任务后来自己成功了）时，没有给外部来源结掉卡片的接口；目前要你点「知道了，不重做」。只有拾光内置的来源会自动结掉。
- 已决定重做、但执行方一直没回报的卡，会一直停在「已决定，等执行」，显示决定后过了几天。
