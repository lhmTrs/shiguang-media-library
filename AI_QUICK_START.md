# 给其他电脑和 AI 的下载启动指南

## 先确认目标

这是拾光素材库的源代码。请在使用者自己的电脑下载、安装并运行，不是让浏览器访问一个在线素材库。

- 仓库：https://github.com/lhmTrs/shiguang-media-library
- 使用分支：`main`。
- 技术栈：Node.js 22、React、Express；新安装默认内置 SQLite。
- 不需要 MySQL、Redis、OpenAI Key 或原作者账号。AI 分析是可选付费功能，不影响本地管理。
- 仓库不含素材、私人标签、数据库、缓存或密码。首次打开为空库是正常的。
- 先读 `AGENTS.md`、`AI_HANDOFF.md`、`START_HERE.md`；改代码和更新前另读 `CODE_SYNC.md`。

没有终端或文件权限的 AI 只能提供指导，不能声称已下载或启动。不要请求别人把数据库密码、GitHub 令牌或 API Key 发到聊天里。

## 1. 下载 main 分支

检查本机环境：

```sh
git --version
node --version
npm --version
```

Node 必须是 22.x；缺少工具时先向使用者说明需要安装的工具，不要擅自更改已有项目的运行环境。

在使用者指定且不存在同名项目的目录中执行：

```sh
git clone --branch main --single-branch https://github.com/lhmTrs/shiguang-media-library.git
cd shiguang-media-library
```

如果仓库是私有的，需要仓库拥有者授予访问权限，并在本机通过 GitHub CLI、SSH 或凭据管理器完成认证。链接本身不提供访问权限；遇到 404 或认证失败，不要建立空仓库冒充下载成功，也不要更改仓库可见性。

不用 Git 也可在仓库 main 页面选择 Code → Download ZIP，完整解压后进入包含 `package.json` 的目录。**GitHub 下载的源码 ZIP 不是预构建分享包**，仍须执行以下安装步骤；ZIP 安装也不能直接使用 Git 更新脚本。

## 2. 安装并启动

```sh
npm run setup
npm run portable
```

`setup` 检查 Node 版本，缺少运行或构建依赖时执行 `npm ci --include=dev`（即使环境为 production 也安装构建工具），缺少网页构建时执行 `npm run build`，然后检查媒体工具。首次安装需要联网。不要复制其他电脑的 `node_modules`。

`portable` 使用本项目 `data/` 保存独立数据，默认 SQLite，并打开浏览器。若终端已有 `MEDIA_DATA_DIR` 环境变量，它会覆盖默认数据位置，启动前应确认它是否属于本次使用，不能指向原作者或其他项目的库。源码版 `npm start` 保留旧库入口，首次使用不要用它替代 `portable`。

打开终端实际输出的地址，通常是 `http://127.0.0.1:4317/`。端口占用时自动尝试后续端口，不要杀死占用端口的其他程序。不能直接打开 `index.html` 或 `dist/index.html` 代替运行服务，也不要监听公网。

自动打开浏览器不可用时手动访问输出地址。AI 如需前台运行、观察报错，可以使用：

```sh
npm run portable -- --foreground
```

前台进程需要保持运行；结束时用 Ctrl+C。修改源码后要重新 `npm run build`，按原启动方式重启才能加载正式版本。

## 3. 验收和添加素材

AI 至少核对下列实际结果后再报告成功：

1. 服务输出本机地址，访问网页成功；`GET /api/session` 返回 `app: "shiguang-local-media"`。不要公开响应中的会话令牌。
2. 新安装为空库、导航与设置可打开，不应要求连接原作者 MySQL 或填写付费 API Key。
3. 让使用者选择自己的素材目录；只有获得明确授权后才添加，不扫描整台电脑或整块系统盘。
4. 添加一份测试目录后能搜索、试听或预览；缺少媒体工具时准确说明哪些预览暂不可用。
5. 报告实际地址、启动方式、数据位置及未验证项目，而不是只贴预计地址。

初次验收可先只读浏览。移动、改名、删除会操作原文件，必须通过原有确认流程；功能测试使用临时副本。添加目录后，应用可能在该目录下创建 `.shiguang` 元数据清单，这是标签与身份记录，不应随意删除。

## 4. 可选媒体工具与排错

```sh
npm run doctor
```

FFmpeg/FFprobe 用于波形、媒体参数和兼容播放，ExifTool 用于拍摄日期；缺少时相关功能会降级，不应因此删除素材索引或要求安装 MySQL。macOS HEIC/RAW 预览还会使用系统 `sips`；废纸篓组件需要 Swift 编译工具，缺少时安全禁用删除。Windows/Linux 的系统集成限制见 `START_HERE.md`，不要把浏览器兼容等同于已实测所有操作系统。

依赖安装失败时先检查 Node 22、网络与报错；原生模块编译问题参照 `START_HERE.md`。数据库连接失败时不要删除既有配置或将旧库切成空 SQLite，先保留数据并诊断。不要绕过安全检查或执行未经确认的永久删除。

## 5. 停止和更新

后台便携模式确认任务结束后执行：

```sh
npm run stop:portable
```

关闭浏览器不会停止服务。前台模式用 Ctrl+C。

已有 Git 安装先读 `CODE_SYNC.md`，检查工作区干净，停止使用该代码目录的服务，再执行：

```sh
npm run update:check
npm run update:code
npm run portable
```

更新脚本只允许快进、不覆盖本地修改，会安装锁定依赖并重新构建。不要直接再次克隆到已有项目上，也不要删除 `data/` 解决更新问题。源代码同步不包含素材和数据库；备份库时先停止服务，再备份完整数据目录。

## 可转发给 AI 的任务

> 请在我的电脑安装并启动 https://github.com/lhmTrs/shiguang-media-library 的 main 分支。先读 README.md 和 AI_QUICK_START.md，再遵循 AGENTS.md、AI_HANDOFF.md 与 START_HERE.md。使用 Node.js 22，执行 npm run setup 和 npm run portable，新安装默认 SQLite，不安装 MySQL/Redis、不使用原作者凭证。核对服务真实响应后给我实际访问地址；添加素材目录前问我，测试文件操作只用副本，不删除或覆盖我的已有数据。
