# Updream 已登记任务的本机进度

这是一份只读展示适配器，不是生成、下载或入库执行器。它只读本机跟进队列登记的任务和其指向的状态文件，不扫描账号历史，不查询平台、不取凭据，也不启动跟进服务。展示偏好单独保存；查看、展开与已读都不改变原任务或交付结果。

## 数据源和限制

默认读取 `~/Library/Application Support/CodexUpdream/followups/jobs/<sha256(task_id)>.json` 的 version 1 队列。服务端可通过 `MEDIA_UPDREAM_QUEUE_DIR` 指定另一个明确队列目录，供隔离测试使用；HTTP 不接受路径参数。没有队列时返回 absent，不代建目录，不影响应用启动。

每条队列与源状态最多8MiB，一次读取总预算32MiB，最多200条任务，最多枚举1000项；达到限制返回 degraded/truncated，不能将局部统计当完整任务总数。当前用户所有权、私有队列权限、普通文件、链接、真实父路径与读前后身份/长度/mtime都会检查。损坏、未知版本、半写、链接或超大记录明确降级；未登记文件不读取。接口仅输出白名单，不返回源文件路径、提示词、素材、签名下载URL、通知正文、凭据或原异常。

当前执行脚本没有持久化最近一次成功平台查询的时间，因此 `upstreamUpdatedAt=null`。`readAt` 是网页这次读取时间；`localRecordUpdatedAt` 只表示本地记录修改时间。活跃任务的记录超过两分钟没有修改时，`stale={since,reason:'local_record_old'}`，这也不是平台失败证据。没有明确百分比量纲时 `progress=null`；只有记录中带 `%` 的0到100字符串投影为百分比。

阶段来自原始持久信号：生成中、下载中、等待入库、导入中、已入库、失败、已停止或待核对。现有执行器没有“正在校验”的独立检查点，不编造该阶段；有 `download_result.probe` 时可用 `lastCompletedPhase='validating'` 表示原执行方已记录校验完成。下载不等于入库；只有原交付回执 `stage=ready, verified=true`，并且目标和标识一致、已存交付签名一致时，才显示 imported。这里标记 `verification='executor_recorded'`，不是页面实时重读视频文件。通知异常不会将已核验入库结果改成失败。本机取消跟进不等于平台生成已取消，缺少平台取消证据时显示待核对。

旧队列在首次交付时才固定素材库实例与文件夹编号；此前目标身份显示 unconfirmed，不能声称目标漂移缺口已修复。目标始终来自自身登记记录，不随当前选择的项目变化。已记录实例与当前库不一致时 identity=other_library，不提供查看视频动作；当前库仅在原视频仍具托管授权时允许查看。独立 Skill/执行器及真实在途任务均不在本功能修改范围内。

## API v1

全部路径在 `/api/updream-progress` 下，使用原 Host/Origin、cookie、写token和素材库实例校验，返回 `Cache-Control: no-store`。

- `GET /?scope=all|active|history&offset=0&limit=50`：limit为1到100。返回schemaVersion、readAt、queue、preferences、summary、tasks、total、offset、limit。summary的activeCount/unreadCount/attentionCount不受分页和scope影响，但受明确报告的读取上限限制。showEntry在有活跃/未读任务或队列异常时为true。
- `GET /tasks/:id`：仅返回相同白名单Task，作为查看本机任务记录的入口；不提供原始JSON/路径。
- `POST /read {items:[{id,version}]}`：1到100项，version必须是该Task.eventVersion。只标指定的、版本仍吻合的项目，返回marked/skipped。未存在或版本改变的任务跳过；后续新结果/异常仍会提醒。无清空所有任务/控制队列接口。

Task字段：id、name、eventVersion、phase、active、attention、unread、createdAt、upstreamUpdatedAt、localRecordUpdatedAt、progress、lastCompletedPhase、stale、target、delivery、notification、recordUrl。target.identity为unconfirmed/recorded/current/other_library；delivery仅对原执行方已核验的入库回执给出projectId/folderId/videoId/relatedImportRequestId/canView。导入回执编号只作关联信息，不代表新文件任务，也不启动重复操作。notification单独投影，未识别状态为unknown。

已读偏好位于当前应用数据目录的 `updream-progress/read.json`，目录0700、文件0600。GET不创建偏好。写入通过单进程串行与跨进程独占锁、重新读取、独占临时文件、fsync及原子替换完成；不回写队列。锁冲突409，不自动删旧锁；偏好异常503或preferences.state=unavailable，不假装标记成功。前端须在结果/异常实际进入可见区域后才提交对应id+版本；不能将未展示记录批量标已读。历史失败保留，已读不代表已解决。

## 隔离验证

`node --test tests/updream-progress*.test.mjs` 使用合成队列、全新SQLite/数据目录与自有应用进程。夹具位于 `tests/helpers/updream-progress-fixture.mjs`，可给前端组合测试复用。测试不触及现用4317、真实队列、钥匙串、平台或真实素材。实际应用测试正常关闭并要求 APPLICATION_CLOSED_KNOWN；素材库不等待远端生成或控制跟进服务。

前端宿主接线由后端持有src/main.tsx；组件由Claude的src/updream/UpdreamTaskEntry.tsx提供。后端单分支在前端组件尚未合入时不能独立构建页面；组合准确候选后再构建和验收，不用假组件冒充通过。合并和现用更新需要本批另行授权。
