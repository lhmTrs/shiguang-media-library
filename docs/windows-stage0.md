# Windows 阶段0：非必需自动观测

独立 workflow `Windows observations (non-required)` 使用 windows-latest、Node 22、锁定依赖和构建，不改变现有 Ubuntu 检查或分支保护。失败继续收集并上传 JSON 和中文摘要，不能把 workflow 不阻塞解释为测试通过。

产物 `windows-observations`：`steps.json` 为安装/构建/工具/探针/测试实际结果，`probe.json` 为原语与媒体观测，`tests.json` 明列8个可移植现有文件及3个暂不选择项，`摘要.md` 为一页中文索引。只打包报告，不上传合成媒体或临时目录、完整路径、环境变量、数据库或凭据。

本地对照（只创建自有合成临时文件，不启动拾光）：

```sh
node scripts/windows-probe.mjs <report-directory>
node scripts/windows-ci-tests.mjs <report-directory>
```

媒体工具可用 `WINDOWS_PROBE_FFMPEG`、`WINDOWS_PROBE_FFPROBE`、`WINDOWS_PROBE_EXIFTOOL` 显式选可执行文件，不经过 shell。探针读写只在自己创建的临时根下进行；不使用系统废纸篓、不连接服务或模型。文件保持占用的子进程以消息正常关闭并记录退出；临时夹具保留在报告目录外。

`observed` 表示成功取得观测，不代表该机制受支持：例如目录 fsync 的 `supported:false` 和错误码是阶段1修复的输入。`failed` 表示探针本身未能取得完整观测。媒体 `ok:false` 明示工具/传参失败，不能当成功。Node 与 bigint 的 inode 比较只代表本次生成文件，不能证明所有磁盘均无精度风险。

8个可移植子集来自原稳定清单，独立使用 Node 测试超时，不改原 POSIX 资源观测器，不扩到全量测试或任何 cloud/device-enrollment/asset-merge-routes/asset-repair-routes 文件。其余 POSIX 句柄、目录刷盘和工具脚本案例显式排除，阶段1后再决定如何纳入。

无桌面 runner 不启动 explorer，不验证窗口实际显示、DPI、交互安装、OneDrive/杀毒占用、移动硬盘和映射盘；这些属于后续 Windows 真机验收。阶段0只提供观测，不把 mock 或 Mac/Linux 对照当作 Windows 通过。
