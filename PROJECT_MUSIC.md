# 项目音乐

入口：项目设计和管理 → 项目音乐（`#/project-music`）。为某个项目用 Suno 或本地模型生成的歌，在这里按「歌曲 › 轮次 › 版本」管理。用户在网页上传，AI 通过接口下载和补写记录。这一页也是新画风的试点。

## 概念与规则

- **歌曲**：状态有进行中、定稿、放弃三种。生成阶段一首歌只属于一个项目。
- **轮次**：改一次提示词算一轮，编号自动递增，不能手改。数据库对 `(song_id, round_no)` 加了唯一约束。
- **版本**：Suno 一次出的 A/B，或本地模型的某个文件。Suno 自动按 A、B… 编号；其他工具默认取文件名。
- **当前最好**：每首歌一个，只能由用户设定。
- **淘汰区**：淘汰只改状态，不删、不搬文件，随时可以恢复。淘汰「当前最好」前会先确认。
- **候选版不进音乐库**：只有定稿的那一版复制进 `personal_item/system_music/<分类>`。定稿走现有的音乐收纳流程（重名或同内容时可选另存、沿用已有或取消），再用 `project_assets` 加入本项目候选。撤回定稿时，音乐库里的文件和项目候选都保留。
- **先补上一轮**：上一轮的「问题整理」和「下一轮方向」都不为空，才能开新一轮。AI 写的条目和你自己写的一句话，任一有内容就算填了，不要求条目格式。页面和接口都会拦。

## A/B 对比（第 2 期）

歌曲标题旁的「对比」，或某个版本行上的「和当前最好对比」，会打开对比页。

- **默认对比**：当前最好对最新版本；没有当前最好时，比最新的两个。左右两边都可以改选任意版本，包括淘汰区里的。
- **同步播放**：两版同时走，只放出一版，另一版静音跟着走（偏差超过 40ms 才悄悄对齐）。空格切换，两版停在同一位置；K 播放或暂停。
- **音量对齐**：按上传时算出的响度估计，把较响的一版调低，只在浏览器里调，不改原文件。有一版没有响度估计时不对齐，并在页面上说明。
- **盲听**：随机决定哪版是「1 号」，只显示 1 号、2 号，并收起版本选择；点「揭晓」或保存结果后公布对应关系。
- **段落标记**：手动打点、改名，点标记两版一起跳过去。
- **歌词跳转**：如果 AI 用 `/agent-notes` 的 `lyricTimes` 给两个版本都提供了每句的开始时间，点某句歌词，两版各跳到自己的那一句。之后切换时，保持这个时间差。
- **结果**：可以只写一句话，也可以选整体哪版更好，或按段落各记一条。结果存进较新那个版本所在的轮次（`project_music_comparisons`），显示在该轮记录的「对比结果」里。只有用户能记，AI 只能读。保存后如果选出的版本不是当前最好，可以一键设为当前最好。

## 每一轮记什么、谁能写

| 字段 | 页面（用户） | AI（`/agent-notes`） |
| --- | --- | --- |
| 提示词：工具、风格、歌词、参数 | 写、确认 | 只能在开新一轮时起草，显示为「待你确认」 |
| Suno 链接或编号 | 写 | 开新一轮时可以带，页面标「AI 填」；你改过就算你填的 |
| Suno 会员档位 | 写（只能你填） | 不能：带了整次拒绝。AI 开的轮次档位留空，确认提示词也不会带出档位 |
| 你的听感 | 写自己的原话 | 只能追加逐字转录，必须带 `verbatim:true`；页面注明会话名和时间 |
| 改了什么、客观检查 | — | 写 |
| 问题整理、下一轮方向 | 可以自己写一段（`userIssues`、`userDirection`），作者记为「你」，和 AI 写的分开存放、分开显示 | 写 `issues`、`nextDirection`；问题必须标来源，原因只能写成「猜测」；不能写用户那两项 |
| 版本取舍（淘汰、当前最好、定稿） | 写 | 不能 |
| 对比结果 | 写 | 只能读 |
| 歌词每句时间（`lyricTimes`，按版本） | — | 写，必须注明方法 |

AI 写的每一段都记录会话名和服务端时间。写入要带 `expectedRevision`，版本号过期时返回 409 `REVISION_CONFLICT`。越权字段会让整次请求被拒绝（403 `AGENT_FIELD_FORBIDDEN`），不会部分写入。

页面和 AI 用的是同一种本机会话，服务端无法从技术上区分两者，所以做了两层防误用：

1. AI 走独立的 `/agent-notes` 接口，只接受 AI 字段。
2. 只能由用户做的操作，要求浏览器自动带上的请求头 `Sec-Fetch-Site: same-origin`。

AI 不得伪造这个请求头，也不得调用这些页面专用接口（项目使用说明和 `/schema` 里都写明了）。刻意伪造仍然能绕过，所以这只是防误用，不是安全边界。另外，用 Playwright 之类的工具驱动真实页面，浏览器会正常带上这个请求头，按规则算作「通过界面操作」。

## 接口

都在 `/api/project-music` 之下，沿用全站的本机地址、会话 Cookie 和写令牌校验。字段规则与示例见 `GET /api/project-music/schema`。

| 用途 | 请求 |
| --- | --- |
| 列表（歌曲、轮次、版本、每轮缺什么） | `GET /projects/:projectId` |
| 一首歌 | `GET /projects/:projectId/songs/:songId` |
| 建歌、开新一轮 | `POST /projects/:projectId/songs`、`POST …/songs/:songId/rounds` |
| 上传 | `POST …/imports` → `PUT …/imports/:id/content`（原始字节）→ 同内容重复时 `POST …/imports/:id/resolve {choice: keep \| cancel}` |
| 播放、下载（支持 Range） | `GET …/versions/:versionId/media`，加 `?download=1` 时带规范文件名 |
| AI 写一轮 | `PATCH …/rounds/:roundId/agent-notes` |
| 页面写一轮、版本、歌曲 | `PATCH …/rounds/:id`、`PATCH …/versions/:id`、`PATCH …/songs/:id` |
| 定稿、撤回定稿 | `POST …/songs/:id/finalize`、`POST …/songs/:id/finalize/:requestId/resolve`、`POST …/songs/:id/unfinalize` |
| 记对比结果（页面专用） | `POST …/songs/:id/comparisons` |

上传只接受 mp3、wav、m4a、flac，单个文件不超过 200MB。同内容重复上传（项目内 SHA-256 相同）时会提示，由用户选择仍然保存或取消，不会悄悄复用已有文件。响应丢失时用原请求编号查回执，不要重发字节。

## 数据与文件

- **新表**（SQLite、MySQL 共用一份定义，见 `server/project-music/schema.mjs`）：`project_music_songs`、`project_music_rounds`、`project_music_versions`、`project_music_comparisons`（对比结果）、`project_music_imports`（上传回执）。时间一律为 UTC 毫秒，业务字段存在 `data_json` 里。
- **托管目录**：`<数据目录>/project-music/<项目>--<id>/<歌名>--<id前8位>/第NN轮/<标签>.<扩展名>`，权限 0700。这个目录不登记为素材根，页面不显示本机路径。
- **原始文件名**：只记在数据库里，下载时使用规范文件名 `歌名-第N轮-标签.扩展名`。
- **文件身份**：每个版本保存 dev、ino、大小、修改时间、ctime 和 SHA-256。播放或下载前先核对，任何一项变了就重算 SHA-256：内容变了返回 409 `MUSIC_FILE_CHANGED`，不播放、不下载（包括同长度改写后再把修改时间改回原值）；内容没变只是属性变了，就刷新记录的身份信息，照常使用。
- **波形与响度**：上传时用 ffmpeg 解码，算出 300 个峰值和一个 RMS 响度估计。ffmpeg 不可用时只是没有波形，上传照常。
- **时间**：接口存 UTC 毫秒；页面一律按北京时间显示，格式 `YYYY-MM-DD HH:mm`。AI 记录的原话时间也必须是这个格式。
- **一次性迁移**：`server/mysql.mjs` 的 SQLite→MySQL 迁移清单已登记五张表，连同唯一约束和索引一起迁移。

## 新画风

- 只在 `.sg-music` 里生效，只用 `--sg-*` 变量。不改现有的 `--c-*` 变量和其他页面。
- 默认「跟随主题」：`--sg-*` 从当前主题的 token 派生，切到深色等主题时跟着变。
- 「新画风试用：配色」开关提供纸张、工作室、画廊三套固定色值，选择只记在本浏览器（`shiguang.musicPalette.v1`），不写数据库。全库推广时换成正式主题，这个开关随之去掉。

## 测试

全部只用合成音频和全新临时库。

```sh
node --test tests/project-music.test.mjs   # 真实服务：上传、重复、先补上一轮、AI 越权、版本保护、淘汰区、下载、身份核验、定稿
npm run build && node --test tests/project-music-ui.mjs   # 真实应用界面，需要系统 Chrome
node --test tests/project-music-compare-ui.mjs   # 对比页：切换同位置、音量对齐、盲听、打点、歌词跳转、记结果
PROJECT_MUSIC_MYSQLD=/path/to/mysqld node tests/project-music-mysql.mjs   # SQLite 与临时 mysqld 跑同一场景并对比，再验证一次性迁移
```

不带 `PROJECT_MUSIC_MYSQLD` 时，MySQL 对比脚本只跑 SQLite 一半，并以退出码 3 结束，不算通过。

## 尚未包含

- 歌词逐句对齐，以及在页面上展示客观检查结果（第 3 期）。
- 删除项目时还不检查项目音乐。
