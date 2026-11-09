# 发布验证与已知限制（2026-11-09）

本次发布包含当前使用版本的运行源码，以及新电脑所需的内置规则、技能与启动脚本。首次使用按 README 执行 `npm run setup` 和 `npm run portable`，默认创建独立 SQLite 库。

## 本次验证

- TypeScript 检查与 Vite 正式构建通过。
- 项目资产、角色语音、参考图片、项目视频与文件夹、文件身份复核、全局提示、分镜、提示词、Codex 管家及分享启动相关的 29 个定向测试文件共 245 项通过，无失败、取消或跳过。
- 最新视频身份复核另有独立 SQLite/文件系统验收：32 项相关用例通过。仅文件属性变化且原内容摘要一致时恢复原视频资格；换文件、改内容、撤权、资料并发变化与未结操作保持拒绝，原资料和镜号关联保留。
- 隔离源码副本的新建 SQLite 库实际启动通过：空目录与项目、网页、分镜初始化格式、内置导演规则四个文件，以及新建合成项目的视频接口可用，测试服务正常退出。
- 上述副本复用了本机已安装依赖；没有把它称为在另一台电脑完成 `npm ci` 或 Windows/Linux 真机验收。测试不使用真实素材、作者数据库或付费模型。

## 仍未完成的回归

完整旧测试集未全通过：2026-11-07 的全量运行观察到 47 项失败，两个云端上传测试模块未正常完成，随后正常中止了该隔离测试运行。本轮未重跑完整旧测试集，原失败记录保留，不能用最新定向测试结果替代完整回归结论。

- 一些音频引擎测试固定了旧阶段源码哈希，或依赖历史验收目录、Git 元数据；干净源码副本中不能直接当作当前发布验收。
- 部分旧云端上传夹具未满足现行 scope binding 等要求，会被安全检查拒绝。未通过取消绑定要求或弱化保护来修复测试。
- 素材合并遇到未被合并器识别的引用表时会返回 `MERGE_REFERENCE_UNKNOWN`，包括新项目模块注册后的部分路径。此情况应保留原素材和关系，不能绕过引用检查强行合并。

## 使用边界

- MySQL 完整适配与中断恢复候选仍有未完成验证；此发布不自动迁移、切换或替换已有数据库，不代表所有 MySQL 版本可用。
- Windows/Linux 系统选择器、文件操作和安全停机仍以各模块明确支持范围为准；界面能打开不等于系统集成已完整通过。
- Codex 的实际模型、图片生成、视频分析及可用额度取决于使用者本机安装、登录与权限；本次发布验证没有调用真实模型。

## 非云端历史失败的定向核对（2026-11-10，#7）

以下区分用户/作者的旧报告与本机当次实测；不表示完整非云端套件已通过。默认测试仍保留本地失败用例，不因 CI 只选择稳定集合而隐藏它们。

| 文件 / 用例 | 旧报告 | 本次准确观察与处理 |
| --- | --- | --- |
| `concierge-attachments.test.mjs` / `PDF and Office existing local tools parse bounded text without execution` | 用户报告在 `698825d` 失败 | 在原 `698825d67461705339fd5ff32e94a24cb1044793` 和当前未改该模块的源码上，使用本机 Node 22.7.0、现有 `pdftotext`/`unzip` 与锁定依赖，分别定向 1/1 通过，退出 0、无遗留组内资源。当前未复现，不将旧失败抹成已修复；缺本机解析工具的环境仍可能失败。未安装工具、未执行附件或真实模型。 |
| `timeline-render-picker.test.mjs` / `W05 original private App: validate/auth/type guards, cancel zero saves, success exactly one original save` | 用户报告在 `698825d` 失败 | 原基线和当前均在启动前复现 `ERR_MODULE_NOT_FOUND`：夹具只复制根模块与 `sql/`，漏掉新增子模块。修正夹具复制嵌套源码、内置规则资源，并保留选择器的其它真实导出；原来只替换 `createFilePicker` 的包装器漏导出 `createVideoFilesPicker`。本批不改产品源码、鉴权或保存断言。修复后原 HTTP App 用例 1/1 通过，仍严格检查鉴权/Origin/类型/偏移、取消零保存和成功恰一次保存；App 正常关闭，退出 0。 |
| `audio-engine-installer.test.mjs` / 双进程同时安装 | 作者报告偶发失败 | #8 单独跟踪同步/异步 `ENGINE_BUSY` 两种竞态与夹具收尾；不在这里把作者观察写成该任务已合并或真实引擎资格。 |

本次 W05 夹具修复的中间启动失败（缺选择器导出、缺内置规则）保留为真实失败；这些 App 在监听前退出 1，不能写成正常关闭 0。最终通过场才取得 `APPLICATION_CLOSED_KNOWN` 和原退出 0。PDF/Office 及 W05 的两份原基线结果分别是 PASS / FAIL，不归因于主题或资产界面 PR。

复核命令（只使用新建合成目录；普通源码安装的浏览器与系统工具要求仍适用）：

```sh
npm test -- --file concierge-attachments.test.mjs --test-name-pattern 'PDF and Office existing local tools parse bounded text without execution'
npm test -- --file timeline-render-picker.test.mjs --test-name-pattern 'W05 original private App'
```

作者在 PR #26 报告的非云端全套 1048 项中 9 失败、1 跳过，是其对应基线/环境的历史结果；本批没有重新运行并确认该完整清单，不能将剩余未逐项复现的问题冒称当前已解决。上述定向实测也不代表 W05 浏览器分支、所有文档解析工具版本、Windows/Linux 或完整 MySQL 验证通过。
