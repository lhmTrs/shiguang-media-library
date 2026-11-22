# Windows 运行与正常停止

新安装默认 LOCALAPPDATA\ShiguangMedia。若原分享版 project\data 中有可只读核验的素材库 SQLite 结构或现有本机 MySQL 配置，继续原目录；新旧两份都有效或任一库标记无法核清时，拒绝启动并要求明确 MEDIA_DATA_DIR。显式选择优先，不移动、合并或删除任何库。启动、停止和 doctor 共用同一选择函数；Windows 启动器将本次已选目录传给服务，避免选完后又改选。Mac 目录与信号停止路线保持。

Windows 后台启动：npm run portable；正常停止：npm run stop:portable。前台窗口关闭仍不能保证安全，不支持 Windows foreground。停止脚本不使用 PID 信号或 taskkill：它读取自选数据目录的受保护运行记录，建立本机会话，再经受保护 GET /api/application/identity 绑定 libraryId/runId，用同源 POST /api/application/shutdown 提交唯一 requestId。公共 GET /api/session 仅新增 platform。

202 仅表示接受。服务实际等待原入口/模块收尾、元数据 afterCommit、清单写入、HTTP close 及原生 SQLite close（MySQL 则要求 connection.end ACK 和 Worker 正常退出，不 terminate）。覆盖见 application-shutdown 的私有见证和生产接线。Windows 文件本身真实刷盘，普通文件/无链接/目录身份/单链接和大小界限检查、同根临时替换及字节读回后才发布 HMAC 回执；不将目录入口核验冒充 Windows 目录 fsync。客户端只认同实例/请求、未过期且 HMAC 正确的 CLOSED_KNOWN。超时或未结清报告 UNKNOWN，不强制结束服务，旧回执不能证明新实例已关闭。回执不存令牌。

Windows 项目视频及参考图片在已确认目标目录里建立自有暂存，确保同卷；发布为独立副本后，只有实际内容摘要与数据库登记读回一致才能由固定 cwd 的独立清理进程移除自有 original.partial，随后只移除该空目录。失败、重复待决、历史、不明、变化或尚在使用的缓存保留，不递归清理。Mac 暂存和保留规则不变。

服务端词表只包裹开发者静态文案，不遍历或改写用户的标题、笔记、文件名和数据库内容。Mac 原字串保持；Windows 使用资源管理器/回收站/这台电脑，Linux使用文件管理器。

本批 CI 使用随机回环端口、自有临时库和合成项目，验证错误身份/令牌/来源拒绝、保留真实 HTTP 连接时无完成回执、释放后 SQLite/HTTP 正常关闭、签名读回、重启读回原项目，以及新旧两库冲突与暂存反例。未连接正式 MySQL；Windows 桌面、交互安装、映射盘和 OneDrive仍须后续真机。

同批工具路径收尾也覆盖 npm 将平台可选包嵌套在 @openai/codex/node_modules 内的布局；只核对已知 vendor 路径，不运行 shim、递归扫描或安装工具。

Windows 启动复用和 doctor 也经同一受保护接口核对 libraryId/runId，停止客户端复用同一身份匹配规则。可达服务身份不符或旧运行记录无法核清时拒绝另起实例；不把发现服务/进程存活视为正常关闭证明。doctor 仅报告匹配/缺记录/未知，不输出令牌。

旧分享版运行记录若尚无 runId，只有原进程已不存在时才允许恢复启动并生成新身份；这不被当作旧实例可靠关闭证明。原进程仍存活或无法核清则拒绝另起。验证覆盖旧 data 库的真实 CLI 冷启动、项目读回及签名停止。
