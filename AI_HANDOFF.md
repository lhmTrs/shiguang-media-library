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

真实文件夹试用版另读 `FOLDER_VIEW.md`：新旧视图可切换，没有数据库迁移，不能擅自把旧分类清空或把访达路径变化当成已完成身份迁移。

| 路径 | 职责 |
|---|---|
| `server/index.mjs` | HTTP/session、媒体预览、根目录登记、文件操作确认、服务启动 |
| `server/runtime.mjs` | 数据目录优先级与平台默认路径 |
| `server/library.mjs` | SQLite/公共索引、扫描、元数据编辑、安全文件操作、访达计数 |
| `server/mysql*.mjs` | 可选本机 MySQL 连接、同步事务适配与一次性迁移；已配置时断连不降级 |
| `server/music-categories.mjs` | 主分类、真实二级子类及额外分类 |
| `server/tags.mjs` | 标签注册、统计、批量增删 |
| `server/projects.mjs` | 项目、候选/已使用、首次使用时间、快照历史、类型统计 |
| `server/duplicate-audio.mjs` | 文件大小 + SHA-256 重复检测、报告、重复标签与删除后孤立标签清理 |
| `server/missing-files.mjs` | 10 分钟文件状态缓存、仅人工确认的失效索引清理 |
| `server/music-analysis.mjs`、`server/secrets.mjs` | 可选付费音乐分析、密钥加密、诊断与缓存 |
| `src/main.tsx` | 应用状态、搜索/筛选/详情、试听意图和操作流程 |
| `src/AuditionControls.tsx` | 播放器、波形、选段、连续试听；暂停优先于异步连播 |
| `src/ProjectManager.tsx` | 项目页面、媒体类型筛选、图片/视频预览与使用历史 |
| `server/folder-browser.mjs`、`src/FolderBrowser.tsx` | 登记范围内真实目录只读浏览、任意层级、素材路径范围筛选；保留旧分类 |
| `src/*Dialog.tsx`、`*Manager.tsx` | 独立编辑弹窗、分类/标签/重复管理 |
| `src/style.css` | 中文工具界面与响应式布局 |
| `scripts/package.mjs` | 白名单生成干净分享 ZIP，不包含运行数据 |
| `scripts/verify-package.mjs` | 在临时解压目录安装、校验清单、SQLite 启动和基本功能验收 |
| `tests/`、`scripts/qa.mjs` | 单元与浏览器验收，使用临时副本 |

## 4. 数据与重要约定

- `roots` 登记允许访问的素材目录，`assets` 保存原绝对路径、类型、分类、标签、备注、状态、媒体参数及计数。
- `music_categories` 名称为历史兼容，覆盖所有媒体；`asset_subcategories.category_id` 是真实父子归属，不允许任意创建分类字符串。
- `asset_tags` 是注册表，素材实际标签在 `assets.tags`。同一个素材可以有多个普通标签。
- `media_projects`、`project_assets` 独立于分类；项目内 `(project_id,asset_id)` 唯一。实际使用由人确认，不把收藏、试听、访达、复制当成使用；`used_at` 保留首次确认时间。
- 项目快照让离线、废纸篓或已清理索引的历史仍可查看；不要把项目关联当成需要随 assets 删除的垃圾数据。
- 重复音频按字节一致，不是听感指纹；删除后仅剩一个可移除重复标签，但离线/改类型/筛选隐藏不算删除。
- 文件状态检查不自动删除数据。清理、移动、改名、废纸篓都保留既有确认与安全边界。
- FFmpeg 等缺失是可降级状态：显示预览/参数错误，而不是删索引或覆盖原文件。
- 连播使用 `wantsPlayback` 意图与请求代次，不要退回仅凭 `audio.paused` 推断用户操作，否则亚秒音频会出现暂停后继续的竞态。

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

解压包验收需要联网安装依赖；默认只操作临时目录，退出会停止测试服务。浏览器扩展验收 `npm run test:browser` 目前以 Mac 的 Chrome/WebKit 为基准，涉及 sips/exiftool/FFmpeg；不是可直接假定跨操作系统通过的测试。MySQL 专项脚本依赖本机 MySQL 安装路径，只做可选开发验证，不是启动前置条件。

Docker 配置仅做静态 Compose 验证，本次没有可用守护进程来执行镜像构建。不得把“提供 Dockerfile”写成“Windows/Docker 已完整实测”。不要自动启动或修改用户 Docker 服务。

## 7. 发布与后续工作

`npm run package` 先构建，再按白名单生成 ZIP 与 SHA-256。不要发送整个开发工作区，不要附私人数据目录。发布前重新执行包验收；清单可核对篡改但不是可信签名。

后续可做：真实 Windows/Linux 验收、原生跨平台废纸篓、项目导出、达芬奇 XML 导入。尚未实现剪映草稿解析、自动判断项目实际使用、版权识别、云同步或安装器级免环境分发。不要把这些当成已有功能。
