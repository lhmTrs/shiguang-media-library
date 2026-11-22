# Windows 原生工具

Codex 查找只选择 codex.exe：先扫描所有 PATH 目录，再查 PATH 邻接的 npm @openai/codex 或 codex-win32-x64/arm64 vendor 布局；.cmd 不会中断后续查找。MEDIA_CODEX_BIN 在 Windows 必须是存在的原生 exe 绝对路径。doctor 只检查发现，不连接账号或发送请求。布局依据：[官方启动器](https://github.com/openai/codex/blob/main/codex-cli/bin/codex.js)。

媒体后台调用在 Windows 选择 PATH 中的 exe，也可通过 MEDIA_FFMPEG_BIN、MEDIA_FFPROBE_BIN、MEDIA_EXIFTOOL_BIN 指定绝对 exe 路径；原 MEDIA_STORYBOARD_FFPROBE 仍用于视频探测。明确配置错误即失败，不偷偷回退。不要独立搬走 ExifTool 所需的伴随文件。Mac 路线和文案保持。

Windows 实测 ExifTool 的 Perl 文件名处理拒绝 emoji surrogate，单加 filename=utf8 不能解决。因此 Windows 的拍摄日期读取从持有的普通文件句柄送入 stdin，同时核对前后身份，命令仍设置 filename=utf8。没有改名或复制原件；Mac 原路径参数保持。参考：[ExifTool Unicode 文档](https://exiftool.org/exiftool_pod.html#WINDOWS-UNICODE-FILE-NAMES)。

资源管理器收到的是单独路径参数、shell=false。进程 spawn 只代表已发起请求，之后的退出码不能证明桌面窗口已打开；API 原有成功字段仅表示请求执行，真机桌面仍待后续验收。

独立 Windows workflow 使用合成中文 emoji MP4 验证 FFmpeg/FFprobe 和 ExifTool stdin，以及只选择原生程序、显式缺失配置拒绝、cmd 不阻断后续查找、参数边界。模拟 Explorer 仅验证进程创建契约，不冒充实际桌面。
