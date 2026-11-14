# 项目时间线成片 API 与显式迁移

PROJECT-USAGE-RENDER v1。成片属于真实项目中的真实时间线，只能新关联同项目托管视频。项目视频放进“成片”目录不会自动关联时间线。所有接口继续使用原本机 Host/Origin、会话 Cookie 和写请求的 `X-Local-Token`；GET/HEAD 是读取。接口路径含 `/api`。

## 读取与选片

`GET /api/projects/:projectId/timelines/:timelineId/render?schema=2` 始终返回 schemaVersion=2 的对象。未关联时 link=null、revision=0；解除后保留递增 revision 的 tombstone。默认不带 schema 的 GET 保留旧 null 或 `{path,offset,updatedAt}`，path 由服务器提供，仅用于显示，不能授权任意文件读取。旧 path 记录只读、保持原字节和原身份检查，不自动变成 sourceId。

v2 包括 projectId、timelineId、link、sourceId/name/folder/path、offset、revision、updatedAt、当前与绑定时的 sourceRevision/timelineRevision、availability、verification、playback、sync、video。availability 区分 missing、removed、unavailable、untrusted；stat 变化仅表示 needs_verification，只有既有内容核验确证才表示 content_changed。GET 不 hash、不 probe、不接受新内容、不创建目录。名称、备注和合法项目内移动不等于内容换版。

`GET .../render/sources?q=&folderId=all&page=1&pageSize=50` 返回 schemaVersion=1、projectId/timelineId/timelineRevision、items/total/page/pages/pageSize、folders、folderRoles。page 从 1 开始；pageSize 支持 20/50/60/100/200。folderId 为 all/root/本项目实体 ID。废片可见、禁选；已移除记录不进入候选。sourceId 是项目视频来源 ID，不能使用 assets.id。supported=false 和 null 均不可确认，null 须由明确的信息刷新决定。unchecked 且轻量身份/授权正常的候选仍在 POST 中正式核验。

## 关联、解除、回执

```json
{"requestId":"<UUID>","sourceId":"<source UUID>","offset":0,"expectedRevision":0,"expectedSourceRevision":1,"expectedTimelineRevision":"<opaque timeline revision>"}
```

将上面的请求体 POST 到 render。服务器在核验前后重查托管权、废片位置、支持信息、内容证明和修订号，并用短事务提交 revision+1 与完成回执。DELETE render 接受 `{requestId,expectedRevision}`；只解除该时间线关系，不删除媒体、项目来源或其它采用。所有 revision 为非负安全整数；timelineRevision 是 opaque 字符串，不可加减。offset 的单位秒，有限且绝对值不超过 86400。

操作可能返回 200 的 completed 回执或 202 的 checking/running 回执。按原 requestId 查询 `GET .../render/requests/:requestId`；查询 HTTP200 也可能是 failed/unknown。回执统一包含 schemaVersion/requestId/projectId/timelineId/action/status/statusUrl/result/error。completed.result.render 是历史快照，应用前重读当前 GET。相同请求编号与规范化输入回原结果，不同输入为 REQUEST_ID_CONFLICT。语义拒绝有持久 failed 回执，4xx 的 accepted=true 只表示已登记。unknown 或查询404不能推断未发生，不自动换 ID、重发或恢复。

业务错误有 code/message/error/details；已登记错误另有 requestId/accepted/statusUrl，details 中也有 statusUrl。POST render/choose 固定 410；新 path 写入为 400。新接口不调用原生选择器。

## 成片目录与收纳

`POST /api/project-videos/projects/:projectId/folders/final/ensure` 接受 `{requestId,expectedRolesRevision}`。只有显式准备/确认收纳才调用。首次创建，或自动接管唯一、可核验、普通、根级同名目录；不搬内容、不弹接管确认。完成 result 有 outcome=created/adopted/existing、folder/folderRoles、created/adopted、contentsMoved=false。adopted 的通知按 requestId 去重。已登记角色被外部改名/删除/移动/替换时 needs_review，不自动修复、重建或赋给同名替身。

GET 项目视频保留旧字段，folder 增 role=final/locked=true，folderRoles 增 finalFolderId/finalState/finalErrorCode。后两项废片字段的原含义保留。final 容器和包含它的父级不能通过预览、执行或旧预览改名/移动/删除；final/reject 角色子树不能重叠。

统一收纳 destination 可指定 `{kind:"video",scope:"project",projectId,folderRole:"final"}`，与 folderId/newFolder 互斥。预览只描述；确认复用同一个 ensure 日志，冻结实体目录、物理身份和角色修订。B7 的项目/季集前缀、整个物理目录连续编号、在途保留和查重处理继续使用原实现。批次 destination 与请求摘要保持原始逻辑目标，解析的实体放 resolvedFolder/target；routing options 的已有实体带 role=final。

## 信息刷新、播放及引用保护

`POST /api/project-videos/projects/:projectId/videos/:sourceId/info/refresh` 接受 `{requestId,expectedRevision}`。用户明确刷新才对单文件做有限时、有限输出的 ffprobe，使用同一描述符并前后核验文件版本。刷新不接受不同内容、不重新授予失效权限。来源 JSON 的固定 keys 与 supported:boolean 保持；宽高等可选 mediaInfo 只在记录中缓存，并绑定 basisSha256。旧无缓存数据合法，不匹配的缓存不用于投影。探测不可用返回可查询失败，未知支持信息保持 null。

目录/信息回执查询 `GET /api/project-videos/projects/:projectId/operations/:requestId` 按 kind 路由，不交给旧文件操作恢复器。日志复用 project_video_operations 的独立 namespace，不增表；不把 operations、approvals、imports 跨机器恢复为可执行任务。异步工作冻结真实数据库实例，切库不因 UUID/资料相同而继续写入新库。

`GET/HEAD .../render/media?renderRevision=N` 复用项目视频的受管理句柄/活动响应，版本或内容不符拒绝；支持 Range、HEAD、416 和断连资源释放。旧不带参数客户端仍受同样授权和旧身份检查。canPlay 表示服务器允许读取，不保证所有浏览器解码。头发出后只结束流，不再改发 JSON。

RENDER_IN_USE 保护移入废片、移除、覆盖与接受不同内容，包括父子树、批量、同物理文件的其它来源和旧 path。普通合法项目内移动继续跟随 sourceId。通用素材 plan/execute/undo 也检查实际被修改/移走的实体，执行和删除原件前复查；原有通用托管视频禁改保护保留。无覆盖副本复制和只读不受此限制。

## 时间线概览

概览透传 revision、warnings、ref.key、retained 和 occurrences。occurrenceId 由本修订、引用 key 和原始序号派生，只在该修订稳定，不依赖可能为空的 clipId。disabled 原义保留。start/end/sourceIn/sourceOut/duration 单位秒；video.durationMs 为毫秒，未知不填 0。

界面标题为“此刻时间线上的音效”。t=currentTime-offset；当前区间 start<=t<end，接下来 t<start<=t+10。disabled、retained、位置未知不进入即时清单；未确认的 used=false 不能当成已确认可听。XML/来源版本不匹配时 canSynchronize=false；不改 offset、不拉伸时间。不分析混音或调用模型。

## Schema 2 与显式迁移

唯一 DDL 为 `project_renders.revision INTEGER/BIGINT NOT NULL DEFAULT 1`。新空库可初始化；旧表启动/GET 不 ALTER，旧行读作 revision=1，旧写入须先显式迁移。MySQL 的此列为 BIGINT，时间线自身的 opaque revision 仍为 VARCHAR(36)。

离线 SQLite，先停止该库的写入并备份整个数据目录（包括完整原库、配置和媒体关联资料），再预演：

```sh
node server/project-renders.mjs migrate-sqlite /absolute/test-data/library.sqlite
node server/project-renders.mjs migrate-sqlite /absolute/test-data/library.sqlite --apply --backup /absolute/backups/renders-before-v2.json
```

第二条只有明确授权该库迁移后执行。备份文件必须不存在；写备份后再次比对源行，再 ALTER 并核对 payload 原字节及所有 revision=1。重复调用幂等，不通过启动/GET 隐式执行。程序化入口 `migrateRenderSchema(db,{apply,backupFile})` 同时生成 MySQL BIGINT 预演/执行语句；本批没有真实 MySQL 迁移验证，不能据此声称通过。

`ProjectRenders.snapshot/validateBackup/restoreRows` 提供严格、带版本的成片元数据导出/导入；schemaVersion=1 旧三列备份补 revision=1，v2 严格检查新列、payload、真实时间线与同项目 sourceId，不覆盖不同已有记录。视频备份继续使用原严格校验，可选 finalFolderId/mediaInfo 不放宽未知 keys；目录跨项目、removed、角色重叠均拒绝。恢复不恢复读取 approvals，所以相同路径也不自动授信。

代码回退前必须保留当前完整库及新增关系/后续写入。停写、导出当前成片元数据和数据库整备份，再决定保留 v2 表供恢复或在副本中转换。不能直接退代码/丢 revision/tombstone，也不能把迁移前备份覆盖到有后续写入的库。真实库迁移、数据恢复、合并和更新运行版需各自的明确授权。

隔离启动例（先创建自有目录，使用本机空闲端口）：

```sh
MEDIA_DATA_DIR=/absolute/test-data MEDIA_PERSONAL_ITEM_DIR=/absolute/test-media MEDIA_SKIP_IMPORT=1 MEDIA_CONTAINER=0 PORT=4518 MEDIA_DISABLE_DESKTOP_NATIVE=1 MEDIA_CODEX_AUTOCONNECT=0 node server/index.mjs
```

服务仅监听 127.0.0.1；测试应另加启动前的 loopback 护栏，禁止隐式/通配与现用端口，记录实际监听、正常 close 与资源清零。正常 SIGTERM 后以 APPLICATION_CLOSED_KNOWN 和已关闭 listener 为结清证据，不凭 PID 消失推断。测试仅使用合成媒体与空 SQLite；不调用真实模型/桌面，不操作真实 MySQL。
