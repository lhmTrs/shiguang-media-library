# 拾光素材库：分享版使用说明

这是本机运行的素材管理网页，不是云盘。可以管理照片、视频、音乐、音效、标签、二级分类、重复音频和项目使用记录。

**不需要安装 MySQL。新安装默认使用内置 SQLite，首次启动是空素材库。**

分享包包含源代码、已构建网页和安装说明，不含原作者的素材、数据库、密码、API Key、缓存或操作记录。不是免安装二进制 App，也不是已有素材库的备份。

## 方式 A：普通电脑安装，推荐

1. 完整解压 ZIP，不要直接在压缩包里运行，也不要只打开 `dist/index.html`。
2. 安装 [Node.js 22.x](https://nodejs.org/en/download/archive/v22)。本版按 Node 22 验证，不建议直接换成其他大版本。
3. Mac 双击 `启动分享版.command`；Windows 双击 `安装并启动.cmd`。首次需要联网下载 npm 依赖，完成后打开本机浏览器。
4. 终端用户也可以在解压目录运行：

```sh
npm run setup
npm start
```

上面的 `npm start` 指**分享包**。维护者原始源码的 `npm start` 保留旧库启动方式，原始源码要测试隔离分享模式请用 `npm run portable`。可检查 `SHARE_PACKAGE.json` 判断是否为分享包。

地址通常是 `http://127.0.0.1:4317/`。端口占用会使用下一个端口，请看终端实际输出。关闭浏览器不会停止后台服务。

```sh
npm run doctor
npm run stop:portable
```

`doctor` 只检查环境，不安装系统软件、不连接或打印 MySQL 密码；`stop:portable` 在确认服务身份且没有运行中的任务后停止分享版，不删除数据。

Mac 若提示没有执行权限，可在此目录运行 `chmod +x ./启动分享版.command` 后再打开；不要为此关闭系统安全设置。

### 媒体工具

| 工具 | 是否必须 | 缺少时的影响 |
|---|---|---|
| Node.js 22 + npm | 普通安装必须 | 无法启动 |
| SQLite | 已随依赖提供 | 不用单独安装，也不用安装 MySQL |
| FFmpeg、FFprobe | 媒体库强烈建议 | 波形、媒体参数、缩略图和兼容预览可能失败；标签、项目、普通文件索引仍可用 |
| ExifTool | 建议 | 可能读不到照片/视频内嵌拍摄日期 |
| macOS Command Line Tools | Mac 可选 | 无法编译废纸篓组件时，删除功能安全禁用 |
| OpenAI API 额度 | 可选 | 不影响本地整理；ChatGPT Plus 不等于 API 额度 |

已安装 Homebrew 的 Mac 可运行 `brew install ffmpeg exiftool`。Debian/Ubuntu 可运行 `sudo apt-get install ffmpeg libimage-exiftool-perl`。Windows 请从 [FFmpeg 官方下载入口](https://ffmpeg.org/download.html) 和 [ExifTool 官网](https://exiftool.org/) 安装并加入 PATH，再重新打开终端。不要执行陌生来源的一键安装脚本。

如果 `npm ci` 报原生模块编译错误，先确认 Node 是 22，且没有复制其他电脑的 `node_modules`；再按错误安装本机编译工具（Mac Command Line Tools、Linux 的 Python3/make/g++、Windows 的 Python/Visual C++ 构建工具）。使用 `node scripts/setup.mjs --reinstall` 重装依赖。

## 添加素材

打开“添加素材目录”，选择目录类型。Mac 和 Windows 原生运行时可点击“选择文件夹”；Windows 使用系统自带 Windows PowerShell / WinForms，不需要另装选择器。取消选择不会登记或扫描目录。若系统组件被组织策略禁用、窗口不可用，或运行在容器中，仍可在“素材文件夹绝对路径”填写目录并点击“添加路径”。例如 Mac `/Users/你的用户名/Movies/素材`，Windows `D:\素材\音效`。Windows 原生弹窗代码已加入，尚未在真实 Windows 桌面验收；不要据此视为全部 Windows 功能已通过。

只扫描主动添加的目录，不扫描整台电脑。音乐目录请明确选“音乐”，音效目录选“音效”；不要为了省事添加整块系统盘。外接硬盘断开会保留离线记录，不会自动删除。

## 数据位置与迁移

- 普通分享模式：解压目录的 `data/`，首次启动自动创建；SQLite 文件为 `data/library.sqlite`。
- 数据文件夹还包含预览缓存、操作记录、备份和本机加密密钥，不要随意分享。备份时先停止服务，再备份整个 `data/`，不要只复制一个运行中的 SQLite 文件。
- 可用 `MEDIA_DATA_DIR` 显式指定其他数据目录；它的优先级高于便携模式。交给 AI 时应提醒它不要擅自使用你现有库的目录。
- 移动整个程序目录前先停止服务。程序目录可移动，但素材路径仍是原来的绝对路径；换电脑后需要重新添加本机素材，旧路径不会自动变成新路径。
- 可选 MySQL 由使用者在“设置与缓存”自行配置；不要使用原作者账户。已有数据目录若配置了 MySQL，连接失败会明确报错，不会静默退回空 SQLite。不要删除配置来“修好”已有库。

## 方式 B：Docker，可不在宿主机安装 Node/MySQL/媒体工具

需要先安装并启动 Docker（包含 Compose）。这是可选配置：本次交付环境的 Docker 守护进程未启动，因此**仅校验了 Compose 配置，未实际构建/运行 Docker 镜像**。普通 Mac + SQLite 启动另有实际验收。

将 `.env.example` 复制为 `.env`，把 `MEDIA_SOURCE_DIR` 改成你明确允许容器读取的素材文件夹绝对路径；Windows 推荐 `D:/MyMedia`。如使用默认 `./media`，先在项目目录创建 `media` 文件夹并放入测试素材。

```sh
docker compose up --build -d
```

打开 `http://127.0.0.1:4317/`，添加素材路径时填**容器内路径 `/media`**，不是宿主机路径。端口 4317 被占用时先停止占用服务，或同步修改容器内 PORT、健康检查及端口映射；不要只改映射端口，否则现有会话/Host 校验会拒绝。

- 镜像内含 Node 22、FFmpeg、FFprobe、ExifTool，不含 MySQL 服务。
- 只发布宿主机 `127.0.0.1`，不要改成公网监听，也不要当成多用户服务器。
- 素材目录默认只读挂载；可加标签、分类和项目记录，但禁止原文件改名、移动、删除和恢复。
- 容器不能弹出宿主机文件夹选择器或打开宿主机访达；用 `/media` 添加目录。原文件定位请在宿主机完成。
- 数据在 Compose 命名卷 `shiguang_data`（实际卷名带项目名前缀）。`docker compose down` 保留数据；**不要使用 `docker compose down -v`，它会删除数据库卷**。
- Docker/Linux 中 HEIC/RAW 预览不保证成功；失败不影响索引和原文件。

停止：`docker compose stop`。查看启动日志：`docker compose logs --tail=100 app`，分享日志前注意隐藏本机路径和私密内容。

官方参考：[Docker Compose 挂载配置](https://docs.docker.com/reference/compose-file/services/)、[只读挂载](https://docs.docker.com/engine/storage/bind-mounts/)。

## 平台与测试边界

Mac 原生模式验证最完整。Windows 提供系统文件夹选择与手动路径添加，Linux 提供手动路径添加；本次未在真实 Windows/Linux 电脑完整验收。非 Mac 废纸篓禁用，Finder 名称仍沿用原界面。浏览器兼容不等于操作系统兼容。普通分享包初次安装需要联网，不包含 Node 安装器、npm 离线缓存或跨平台原生二进制。

完整功能说明见 `README.md`。交给其他 AI 时先让它读 `AGENTS.md` 和 `AI_HANDOFF.md`，不要把当前私人 `data/` 一起发给它。
