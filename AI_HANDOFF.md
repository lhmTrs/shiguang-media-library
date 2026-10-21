# AI 接手、识别与运行说明

## 1. 先识别项目

本项目是“拾光素材库”，本地单用户素材管理工具。技术栈：React 18 + TypeScript + Vite，Express 4 + Node.js 22；主数据支持 SQLite 或本机 MySQL，两者不是同步双写。无需账号注册、无需云服务器。

根目录有 `SHARE_PACKAGE.json` 表示这是生成的干净分享包。`PACKAGE_MANIFEST.json` 为文件哈希清单（不包含清单自身），ZIP 旁还有整体 SHA-256 校验文件。它们用于完整性核对，不是数字签名。

先读 `package.json` 的实际 scripts：原始开发目录保留旧 `start` 行为，分享包把 `start`/`dev` 改为隔离便携入口。不要凭以前聊天记录假设某个固定 PID、端口、数据库或路径。

## 2. 推荐运行步骤

```sh
node --version
npm --version
npm run setup
npm run doctor
npm run portable
```

Node 需为 22.x；`setup` 在缺少本机依赖时执行锁定版本的 `npm ci`，缺少 dist 时构建，不安装 MySQL、不修改系统包管理器。预构建网页已包含，源码修改后仍需 `npm run build`。

应用地址从启动输出读取（默认 4317，原生端口冲突时自动递增）。分享模式数据在根目录 `data/`，不读取原作者原生库。若需要前台调试，使用 `node scripts/portable.mjs --foreground`，Ctrl+C 停止；普通 `portable`/`start` 会启动后台服务，需 `npm run stop:portable` 停止。

不需要 MySQL、OpenAI key 或真实素材来启动。不要为了解决“数据库不存在”替用户安装 MySQL。新库为空是正常状态。

独立测试实例务必使用新目录（Mac/Linux 示例）：

```sh
MEDIA_DATA_DIR=/tmp/shiguang-ai-test-unique MEDIA_SKIP_IMPORT=1 PORT=4517 node server/index.mjs
```

该路径应是本次新建的唯一临时目录，不要复用已有用户目录。Windows PowerShell 先设置 `$env:MEDIA_DATA_DIR`、`$env:MEDIA_SKIP_IMPORT='1'`、`$env:PORT`，然后运行同一 Node 命令。

## 3. 工程地图

当前分类先读 `DIRECTORY_CLASSIFICATION.md`。正式服务使用位置推导的主类/子类（两级封顶），根散文件及根下待确认箱按位置进入待确认。旧视图已停用，历史表保留但不参与正式分类检索，不能擅自清库或删表。

| 路径 | 职责 |
|---|---|
| `server/index.mjs` | HTTP/session、媒体预览、根目录登记、文件操作确认、服务启动 |
| `server/runtime.mjs` | 数据目录优先级与平台默认路径 |
| `server/mysql.mjs` | MySQL 存储：`mysqlColumnType` 负责 SQLite 列类型映射（哈希类列必须 VARCHAR(64)，否则建索引报 1170） |
| `server/library.mjs` | SQLite/公共索引、扫描、元数据编辑、安全文件操作、访达计数 |
| `server/mysql*.mjs` | 可选本机 MySQL 连接、同步事务适配与一次性迁移；已配置时断连不降级 |
| `server/music-categories.mjs` | 主分类、真实二级子类及额外分类 |
| `server/directory-classification.mjs`、`src/directory-labels.ts` | 当前目录投影及仅前端的跨根重名显示；正式服务启用 directoryClassification，历史模块留作兼容 |
| `server/read-cache.mjs` | 历史分类计数缓存与数据库写入观察，当前目录投影统计不使用旧分类缓存 |
| `server/tags.mjs` | 标签注册、统计、批量增删 |
| `server/projects.mjs` | 项目、候选/已使用、首次使用时间、快照历史、类型统计 |
| `server/duplicate-audio.mjs` | 文件大小 + SHA-256 重复检测、报告、重复标签与删除后孤立标签清理 |
| `server/missing-files.mjs` | 10 分钟文件状态缓存、仅人工确认的失效索引清理 |
| `server/music-analysis.mjs`、`server/secrets.mjs` | 可选付费音乐分析、密钥加密、诊断与缓存 |
| `src/main.tsx` | 应用状态、搜索/筛选/详情、试听意图和操作流程 |
| `src/AuditionControls.tsx` | 播放器、波形、选段、连续试听；暂停优先于异步连播 |
| `server/asset-series.mjs`、`src/SeriesAssetList.tsx` | 同目录、同类型和格式、同名前缀的括号编号系列折叠；完整筛选后分组，系列与成员各 60 项分页，展开才加载成员；自然编号排序、跨成员页连续试听 |
| `src/ProjectManager.tsx` | 项目页面、媒体类型筛选、图片/视频预览与使用历史 |
| `server/folder-browser.mjs`、`src/FolderBrowser.tsx`、`src/MoveDestinationPicker.tsx` | 登记范围内真实目录浏览、任意层级、素材路径范围筛选；移动目标浏览与显式新建文件夹，保留旧分类 |
| `src/*Dialog.tsx`、`*Manager.tsx` | 独立编辑弹窗、分类/标签/重复管理 |
| `src/style.css` | 中文工具界面与响应式布局；色值一律写成 `var(--c-xxxxxx)` token，不写死颜色 |
| `src/themes.css`、`src/theme-list.ts` | **生成文件，不要手改**：前者是各界面风格的 token 取值，后者是前端读到的风格清单 |
| `src/theme.ts`、`src/NavigationSettings.tsx` | 风格的应用与持久化（`localStorage.shiguang.theme` → `<html data-theme>`）；「界面设置」弹窗含风格选择与导航显隐 |
| `server/fs-identity.mjs` | 文件身份与路径边界：`within`、`rootIdentity`（dev:ino + /Volumes 判断）、xattr 读写、sha256、可索引扩展名集合（**全项目唯一一份**） |
| `server/fs-manifest.mjs` | 登记根内的 `.shiguang/manifest.json`：原子写、结构校验、条目 ↔ 数据库字段互转 |
| `server/reconcile.mjs` | 对账引擎：路径→dev:ino→xattr→sha256→同名同大小 逐级认领；`reconcilePaths` 是监听用的快路径；`startWatcher` 负责监听与兜底刷新 |
| `scripts/relocate-root.mjs` | 命令行迁移根路径（与界面「重新指定位置」同一套逻辑） |
| `scripts/export-manifest.mjs` | 一次性迁移：把数据库元数据物化成各根清单并立即对账（`--hash` / `--dry-run` / `--root=`） |
| `scripts/theme-gen.mjs` | 界面风格的唯一来源：改 `THEMES` / `OVERRIDES` 后运行；`--tokenize` 才把 style.css 里新写的硬编码色值纳入 token（会备份到 `backups/source/`） |
| `scripts/package.mjs` | 白名单生成干净分享 ZIP，不包含运行数据 |
| `scripts/verify-package.mjs` | 在临时解压目录安装、校验清单、SQLite 启动和基本功能验收 |
| `tests/`、`scripts/qa.mjs` | 单元与浏览器验收，使用临时副本；`tests/hardening.test.mjs` 专守身份误认、清单越界/并发、只读、目录事件、已搬走的根、MySQL 类型映射与索引降级 |

## 4. 数据与重要约定

- `roots` 登记允许访问的素材目录，`assets` 保存原绝对路径、类型、分类、标签、备注、状态、媒体参数及计数。
- **权威方向：文件系统是存在性与位置的真相，`.shiguang/manifest.json` 是身份与元数据的载体，SQLite 只是可重建投影。** 外部整理（访达/脚本/GPT）后由 `server/reconcile.mjs` 认领回原 id；任何"清理"都必须停在"标离线"，**永远不要自动删除 assets 行或清单条目**（那是用户唯一能找回标签的线索）。新增写文件系统的功能时，要一并考虑"这算不算一次外部变更、对账能不能认出来"。
- 列表容器蒙层：`listLoading = loading || refreshing`，且需 `assets.length > 0`（空列表首次加载已有自己的大转圈，别叠两层）；因为页面整体滚动、列表常高于一屏，蒙层用 `position: fixed` + 实测 `getBoundingClientRect()` 贴合可见区域（`resultsBodyRef`），滚动/缩放时重算——用 `absolute inset:0` 会把转圈甩到屏幕外。
- 自动刷新使用 `refresh({ silent: true })`，不设置 `refreshing`；先探测 `/roots` 修订号与 `/jobs`，变化时才读取完整数据。`src/refresh-preferences.ts` 定义本浏览器偏好 `shiguang.refreshSeconds`（默认 30 秒，可选 0/15/30/60/120/300），「界面设置」可改；0 同时停用自动文件检查，但手动操作与活动任务进度轮询仍保留。文件检查间隔最短 60 秒。后台请求不重叠，前台请求优先，输入/未保存详情/弹窗/页面隐藏时暂缓，响应提交前再次校验；不能用自动更新覆盖草稿。前台 `refresh` 的加载状态必须在 `finally` 释放。
- 界面耗时操作一律走 `run(fn, label)` / `runWith(label, fn)`：它同时负责禁用按钮（`busy`）与显示"正在做什么"的全屏遮罩；列表重新读取只用 `refreshing` 做内联提示（不遮内容）；有扫描任务时 `jobsActive` 驱动 1.5 秒轮询。新增重操作请用 `runWith("正在…", fn)`，不要另造一套 loading 状态。
- 清单写入必须过三道闸：`writeManifest` 里串行化 + 唯一临时名（防并发踩踏）、`prepareManifestDir` 的符号链接/越界校验与"绝不代建登记目录"、（`MEDIA_READONLY_FILES=1` 时直接跳过）。只读模式下对账仍会索引，只是不写登记目录。
- 根的生死：**注销只置 `roots.retired=1`，绝不 DELETE roots 行** —— 删了 `checked()` 会抛"未登记的素材目录"，那批资产的试听/预览会全部坏掉。`roots()` 只返回在管的根（扫描/监听/导航/重叠校验都用它），`allRoots()` 才含已注销的。迁移根路径（`relocateRoot`）**保持 root_id**、只改 `roots.path`，再靠对账按身份认领，所以不需要迁移任何关联表。
- 日常素材可见性统一使用 `lib.activeAssetScope()`：列表、搜索、收藏、待确认、类型/格式/分类统计、标签计数和重复检测排除已注销根，不删除其索引。`asset(id)` 仍可读取历史数据，项目历史保留但该素材标为不可用；恢复登记后同一 ID 和属性重新显示。不要通过把素材标为删除/离线来实现注销隐藏。
- 已标记 `file_status='missing'` 的素材只在 `view=missing` 的失效列表检索。普通列表（含类型、收藏、待确认、离线、标签和目录检索）由 `nonMissingAssetScope()` 排除；普通导航统计、目录树计数、标签使用量与默认全库导出保持一致，失效数量独立计算。未知、离线、无法访问不等同失效，不额外 stat 或自动删记录；状态重新变为 online 后自动恢复普通可见性。项目历史和显式 ID 读取保留，以便追溯、恢复与撤销。
- 身份匹配逐级降级：路径 → `dev:ino` → xattr(`com.shiguang.assetid`) → `sha256`。第 5 级「同名同大小且唯一」**默认只记进 `report.suspectedClaims`，不认领**（自动认领会把另一个内容不同的文件继承上旧 id 与标签，已实测复现）；要自动认领必须显式 `adoptSuspected` / `MEDIA_ADOPT_SUSPECTED=1`，且条目已有 sha256 而候选哈希不同时永不认领。扫描时就要写入 `dev/ino`（`library.mjs` 的 scanWork），否则"扫描完立刻改名"这条最常见路径拿不到线索。
- 界面风格是纯前端、纯 CSS 变量的事：切换只改 `<html data-theme>` 与 `localStorage`，不落库、不发请求。**改样式时不要在 `src/style.css` 里写死颜色**——写死的色块在深色/午夜蓝下不会跟随，改用 `var(--c-xxxxxx)` 或 `var(--green|--line|--muted|--soft)`；新增色值后跑一次 `node scripts/theme-gen.mjs --tokenize`。语义色（素材四类图标、危险/成功/提醒）在 `scripts/theme-gen.mjs` 的 `PROTECTED` 里锁色相，不要随意增删。
- 当前分类取相对根路径前两层，`assets.category/sub/review` 是可重建投影。扫描、移动/撤销、完整/路径对账都要同步，清单导入不能覆盖位置派生字段。正式服务不初始化旧分类表、不接受旧分类写操作。跨根重名只改前端显示，数据中绝不保存拼接前缀。历史分类表不是现版分类来源。
- 当前 `DirectoryClassification.options` 直接对根隔离的目录投影分组计数，不读旧分类表。历史 `MusicCategories.list` 的 UNION/30秒缓存仅为旧模块兼容。`observeDatabase` 仍保留数据库写入观察；不要将其误认为当前目录分类的数据来源。前端 `/categories` 在列表提交后独立请求，失败保留选项，不阻塞列表，不接受过期响应。
- `asset_tags` 是注册表，素材实际标签在 `assets.tags`。同一个素材可以有多个普通标签。
- 搜索栏标签选择器的个人习惯只存在浏览器 `localStorage.shiguang.tagFilterUsage.v1`（`src/tag-usage.ts`），不落库、不发送服务端；选中才记，单标签 10 秒内计数一次，最近使用时间每次选中更新。顶部最多 4 个最近使用，下方按使用次数、最近时间、名称排序；打开时冻结可选标签和顺序，关闭再开才重排，避免勾选时跳位。存储不可用则退回内存，清除浏览器数据会重置。
- 标签右侧数字是当前完整筛选结果中的素材数量，不是点击次数，也不是预测加入该标签后的 OR 结果数。`GET /api/tags/facets` 复用 `lib.assetFilter`，一次返回该范围全部标签的 `n`（当前匹配）和 `total`（保留其他筛选、去掉标签条件的基准数量），不会修改注册表或素材。面板打开后保留候选项的排序快照，但数字随最新 props 更新；计数为 0 的候选项在全部/搜索/最近使用区隐藏，恢复非零时按原顺序重新显示。已选条件保留在独立区域，避免零结果时无法取消。
- `src/tag-facet-cache.ts` 将整组统计保存在 `localStorage.shiguang.tagFacetCache.v1`，按规范化筛选条件缓存，去掉分页/排序，上限 24 组、约 750K 字符、单条 10 分钟。每次读取先请求 `/api/tags/revision` 的廉价版本号；`ReadCache` 在数据库写入/事务时递增版本，扫描、标签接口、AI 批量标注、注销及删除都会使旧版本不可复用，重启/换库也隔离。网页 API 写入成功立即清空统计缓存；在途旧请求不得回填。此缓存与最近使用/点击计数独立；更新不阻挡素材列表，失败保留原选项并提示刷新。浏览器不支持存储时直接查询。外部接口变更在下一次筛选/刷新时检查版本；没有实时推送，也不检测绕过应用的直接 SQL。
- 素材关键词搜索由 `server/search-query.mjs` 统一拆词：空白分隔、双引号内保留词组、去重；`qMode=all`（默认）要求每个词分别命中名称/标签/备注/主子类之一，`any` 为任一命中。`qField=name` 只检索名称，默认 `all` 保留跨字段匹配；前端「仅搜索名称」纳入导航记忆、刷新及标签统计缓存 key。`server/search-aliases.mjs` 内置保守中英文词组，仅对音效扩展同义词，不写标签、不改原文件；已知英文词用单词边界，未知词保留转义 LIKE。每个关键词各自展开再组合 AND/OR，不拆完整引号词组。SQLite 按需注册 REGEXP，MySQL 使用原生 REGEXP。AI 批量标注选择通过 `expandAliases:false` 保留字面范围，不能因搜索词库升级而扩大写入对象。`lib.assetFilter` 统一用于列表、分页和目录分类统计；最多 32 词、2000 字。访达次数排序同次数按名称倒序，其他排序不变。不要在前端仅过滤当前页。
- AI 批量标签/备注使用 `server/metadata-batches.mjs` 和 `AI_METADATA_API.md`，通过本机会话绑定的预览确认写入，不能让外部 AI 直接连库。`metadata_batches` 保存批次 before/after、依据和撤销状态，迁移 MySQL 时一并复制；`scripts/annotate.mjs` 仅调用 HTTP，不读取密码。旧备注默认只补空白，覆盖需显式 replace。预览后变更跳过，撤销只恢复本批实际改变且未再被修改的字段。原媒体不改，清单通过既有 hook 防抖同步；离线根的清单写入不保证当场完成。网页操作记录可查看并撤销批量标注。
- `media_projects`、`project_assets` 独立于分类；项目内 `(project_id,asset_id)` 唯一。实际使用由人确认，不把收藏、试听、访达、复制当成使用；`used_at` 保留首次确认时间。
- 项目快照让离线、废纸篓或已清理索引的历史仍可查看；不要把项目关联当成需要随 assets 删除的垃圾数据。
- 重复音频按字节一致，不是听感指纹；删除后仅剩一个可移除重复标签，但离线/改类型/筛选隐藏不算删除。
- 一键清理见 `server/duplicate-cleanup.mjs`：当前检测范围的完整报告（不按前端搜索缩小），绑定会话的一次性预览确认，10分钟过期。预览和执行均重算 SHA-256，逐项走废纸篓和可撤销操作记录，保留者离线/变化时整组跳过。项目引用、独立标签/备注/收藏冲突不自动丢弃，结果逐组报告。开发和验收只能用临时副本，不要调用真实清理接口试功能。
- `roots.managed_added_ms` 是新增登记的真实毫秒时间；旧库保持 NULL，绝不伪造。`management_order` 是持久化保留顺序，默认新库按登记先后追加；旧 MySQL 无可靠历史顺序，迁移先备份并按路径生成初始顺序，跨根清理必须由用户确认。预览可手动调序，显式保存后覆盖默认优先级；注销、恢复、路径迁移不改变时间/顺序。此数据只在本机库中维护。
- 文件状态检查不自动删除数据。清理、移动、改名、废纸篓都保留既有确认与安全边界。
- FFmpeg 等缺失是可降级状态：显示预览/参数错误，而不是删索引或覆盖原文件。
- 连播使用 `wantsPlayback` 意图与请求代次，不要退回仅凭 `audio.paused` 推断用户操作，否则亚秒音频会出现暂停后继续的竞态。
- 列表默认启用同系列分组，可切换平铺，偏好仅存 `localStorage.shiguang.seriesMode`；网格不折叠。识别仅接受末尾 `(数字)` 或 `（数字）`，至少两个不同编号，同根/同直接父目录/同素材类型/同格式/完全相同前缀才合并；不依据标签、相似含义或内容重复推断。仅使用当前完整搜索结果构建分组，不做当前页局部折叠；成员按需读取，每次最多 60 项，不自动选择折叠组成员。`/api/asset-series` 返回代表素材与组计数，`/members` 返回组成员，`/adjacent` 按完整分组顺序跳过离线及不可试听项；组键是不可逆摘要，不接受任意路径。所有端点复用 active/nonMissing/关键词/标签等筛选与现有会话保护。索引是进程内 30 秒只读缓存，受数据库写入观察失效，不新增表和媒体写操作。名称与访达排序由该模块在完整筛选范围内自然排序后分页，不能先 LIMIT 再排序。
- 分页由 `server/pagination.mjs` 统一校验 `pageSize`（默认 60，上限 200），普通 SQL 列表、自然排序列表、系列列表、成员页和连续试听定位必须使用同一大小；页码越界收敛到末页。前端 `PaginationControls` 提供数字页码、省略号及远页输入，主列表与系列成员共用。每页选项 20/50/60/100/200 仅存浏览器 `shiguang.pageSize`，修改后回第一页；分组模式数量指列表组/独立项，成员页指实际素材。此规则替代上文固定 60 项的初版描述，标签统计缓存不区分页大小。

数据优先级：显式 `MEDIA_DATA_DIR` > `MEDIA_PORTABLE=1` 时的项目 `data/` > 原生平台默认目录。Mac 原生目录保持历史兼容；不要把原生旧库误认为分享包数据。

## 5. HTTP 接口与调试

先 `GET /api/session`，保存响应 Cookie 和 JSON `token`。后续请求带 Cookie；写请求还需 `X-Local-Token: token`、JSON Content-Type。只允许 127.0.0.1 对应端口，不能从另一个 origin 发起任意写入。

主要接口：`/api/assets`、`/api/roots`、`/api/tags`、`/api/categories`、`/api/projects`、`/api/duplicate-audio`、`/api/jobs`。新增目录可 `POST /api/roots` 传 `{path: absolutePath, kind: 'music'|'sfx'|'mixed'|'photo'|'video'}`；只使用用户授权或测试目录。

文件操作先 `POST /api/operations/preview`，再提交一次性 confirmation；不要绕过该流程。容器原文件只读模式会拒绝此类写入。

后台运行记录在当前数据目录 `server.json`，日志在 `server.log`。验证 app/instanceId 和运行任务后才停止，不根据陈旧 PID 杀进程。不要输出 mysql-connection.json、密钥库或 API key 的内容。

## 6. 验证与限制

```sh
npm run build
npm test
node scripts/verify-package.mjs /absolute/path/to/share.zip
```

解压包验收需要联网安装依赖，默认只操作临时目录，退出会停止测试服务。`npm run test:browser` 运行 `scripts/qa-directory-classification.mjs`，基于 Mac 的 Chrome/WebKit 和 FFmpeg；旧 `scripts/qa.mjs` 含退役的人工分类操作，不再作为现版入口。不是跨操作系统完整验收；MySQL 专项脚本仅作可选验证，不是启动前置条件。

Docker 配置仅做静态 Compose 验证，本次没有可用守护进程来执行镜像构建。不得把“提供 Dockerfile”写成“Windows/Docker 已完整实测”。不要自动启动或修改用户 Docker 服务。

## 7. 发布与后续工作

`npm run package` 先构建，再按白名单生成 ZIP 与 SHA-256。不要发送整个开发工作区，不要附私人数据目录。发布前重新执行包验收；清单可核对篡改但不是可信签名。

后续可做：真实 Windows/Linux 验收、原生跨平台废纸篓、项目导出、达芬奇 XML 导入。尚未实现剪映草稿解析、自动判断项目实际使用、版权识别、云同步或安装器级免环境分发。不要把这些当成已有功能。
