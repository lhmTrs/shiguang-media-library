# 项目音乐

入口：项目设计和管理 → 项目音乐（`#/project-music`）。为某个项目用 Suno 或本地模型生成的歌，在这里按「歌曲 › 轮次 › 版本」管理。用户在网页上传，AI 通过接口下载和补写记录。这一页也是新画风的试点。

## 概念与规则

- **歌曲**：状态有进行中、定稿、放弃三种。生成阶段一首歌只属于一个项目。
- **轮次**：改一次提示词算一轮，编号自动递增，不能手改。数据库对 `(song_id, round_no)` 加了唯一约束。
- **版本**：Suno 一次出的 A/B，或本地模型的某个文件。Suno 自动按 A、B… 编号；其他工具默认取文件名。
- **当前最好**：每首歌一个，只能由用户设定。
- **淘汰区**：淘汰只改状态，不删、不搬文件，随时可以恢复。淘汰「当前最好」前会先确认。
- **候选版不进音乐库**：只有定稿的那一版复制进 `personal_item/system_music/<分类>`。定稿走现有的音乐收纳流程（重名或同内容时可选另存、沿用已有或取消），再用 `project_assets` 加入本项目候选。撤回定稿时，音乐库里的文件和项目候选都保留。
- **先补上一轮**：上一轮的「问题整理」和「下一轮方向」都填了，才能开新一轮。页面和接口都会拦。

## 每一轮记什么、谁能写

| 字段 | 页面（用户） | AI（`/agent-notes`） |
| --- | --- | --- |
| 提示词：工具、风格、歌词、参数、Suno 链接、Suno 会员档位 | 写、确认 | 只能在开新一轮时起草，显示为「待你确认」 |
| 你的听感 | 写自己的原话 | 只能追加逐字转录，必须带 `verbatim:true`；页面注明会话名和时间 |
| 改了什么、客观检查 | — | 写 |
| 问题整理、下一轮方向 | 可以自己填（作者记为「你」） | 写；问题必须标来源，原因只能写成「猜测」 |
| 版本取舍（淘汰、当前最好、定稿） | 写 | 不能 |

AI 写的每一段都记录会话名和服务端时间。写入要带 `expectedRevision`，版本号过期时返回 409 `REVISION_CONFLICT`。越权字段会让整次请求被拒绝（403 `AGENT_FIELD_FORBIDDEN`），不会部分写入。

页面和 AI 用的是同一种本机会话，服务端无法从技术上区分两者，所以做了两层防误用：

1. AI 走独立的 `/agent-notes` 接口，只接受 AI 字段。
2. 只能由用户做的操作，要求浏览器自动带上的请求头 `Sec-Fetch-Site: same-origin`。

AI 如果刻意伪造这个请求头可以绕过，所以这只是防误用，不是安全边界。

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

上传只接受 mp3、wav、m4a、flac，单个文件不超过 200MB。同内容重复上传（项目内 SHA-256 相同）时会提示，由用户选择仍然保存或取消，不会悄悄复用已有文件。响应丢失时用原请求编号查回执，不要重发字节。

## 数据与文件

- **新表**（SQLite、MySQL 共用一份定义，见 `server/project-music/schema.mjs`）：`project_music_songs`、`project_music_rounds`、`project_music_versions`、`project_music_comparisons`（对比，第 2 期使用）、`project_music_imports`（上传回执）。时间一律为 UTC 毫秒，业务字段存在 `data_json` 里。
- **托管目录**：`<数据目录>/project-music/<项目>--<id>/<歌名>--<id前8位>/第NN轮/<标签>.<扩展名>`，权限 0700。这个目录不登记为素材根，页面不显示本机路径。
- **原始文件名**：只记在数据库里，下载时使用规范文件名 `歌名-第N轮-标签.扩展名`。
- **文件身份**：每个版本保存 dev、ino、大小、修改时间和 SHA-256。播放或下载前先核对；内容变了返回 409 `MUSIC_FILE_CHANGED`，不播放、不下载。只有时间戳变而内容不变时，更新记录的身份信息。
- **波形与响度**：上传时用 ffmpeg 解码，算出 300 个峰值和一个 RMS 响度估计。ffmpeg 不可用时只是没有波形，上传照常。

## 新画风

- 只在 `.sg-music` 里生效，只用 `--sg-*` 变量。不改现有的 `--c-*` 变量和其他页面。
- 默认「跟随主题」：`--sg-*` 从当前主题的 token 派生，切到深色等主题时跟着变。
- 「新画风试用：配色」开关提供纸张、工作室、画廊三套固定色值，选择只记在本浏览器（`shiguang.musicPalette.v1`），不写数据库。全库推广时换成正式主题，这个开关随之去掉。

## 测试

全部只用合成音频和全新临时库。

```sh
node --test tests/project-music.test.mjs   # 真实服务：上传、重复、先补上一轮、AI 越权、版本保护、淘汰区、下载、身份核验、定稿
npm run build && node --test tests/project-music-ui.mjs   # 真实应用界面，需要系统 Chrome
PROJECT_MUSIC_MYSQLD=/path/to/mysqld node tests/project-music-mysql.mjs   # SQLite 与临时 mysqld 跑同一场景并对比
```

不带 `PROJECT_MUSIC_MYSQLD` 时，MySQL 对比脚本只跑 SQLite 一半，并以退出码 3 结束，不算通过。

## 尚未包含

- A/B 对比页（第 2 期，对比表已建好）。
- 歌词逐句对齐，以及在页面上展示客观检查结果（第 3 期）。
- SQLite→MySQL 一次性迁移清单（`server/mysql.mjs`）还没有登记新表，等 Codex 确认。
- 删除项目时还不检查项目音乐。
