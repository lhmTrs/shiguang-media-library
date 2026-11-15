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

## Schema 2、启动升级与显式离线迁移

唯一自动DDL是 `project_renders.revision INTEGER/BIGINT NOT NULL DEFAULT 1`。仅 `server/index.mjs` 的初次服务启动、HTTP接纳写请求之前调用升级模块；普通 `Projects.init`、GET以及运行中切库不自动迁移。新空库照常建表，已有合格列零备份/零DDL；未知列、类型、约束或未核清的旧升级记录降级，不盲改结构。旧payload、ID、行数及关联不转换、不清理，时间线自己的opaque revision仍为VARCHAR(36)。

备份位于数据目录专用 `backups/render-schema-startup/`，目录0700、文件0600。Windows尚未实现相应ACL保证，旧表启动升级保守降级为permission_denied，不写备份或ALTER；新库和已有合格列不受影响。独占文件包含结构、原始行和payload、行数/digest及数据库身份摘要，不含凭据；完整写入、读回校验并fsync文件/目录后才ALTER。限制100000行/64MiB，超过或IO失败先拒，不截断备份或操作原媒体。SQLite使用BEGIN IMMEDIATE有界写锁，在事务内快照、备份、ALTER、核对后提交。MySQL使用启动专用短生命周期连接（冻结原业务连接相同的serverUuid/database和该迁移connectionId），GET_LOCK协调加project_renders WRITE表锁，覆盖本次唯一ADD列，禁止START TRANSACTION/USE等破坏窗口操作。锁获取等待有界，单次逻辑升级窗口15秒；异步IO返回后复核期限，过期不再ALTER，不以观察超时伪造IO已释放；真实8.2.0专项验证了ALTER前后均挡非协作写，因此旧表自动升级目前只接纳已验证的8.2.0；其它版本在ALTER之前降级unsupported_schema，不外推其它DDL或版本。已有合格列/新库不经过该锁窗口。

升级前持久prepared栅栏，只有DDL、原行核对、提交/锁释放和持久完成均确认后才ready。MySQL DDL隐式提交，事后失败/断连保现场与needs_review，不宣称回滚；下次不能因为列已存在吞掉prepared。MySQL唯一ADD revision语句同时附带`COMMENT 'render-schema-startup-v2:<64位十六进制digest>'`，digest绑定serverUuid/database及经核实的私有备份目录物理身份（dev/ino/birthtime），不含路径、凭据或payload。带此标记的列只有匹配同一状态域、私有ready凭据及可读完整备份才可写；跨dataDir、目录替换、缺失或损坏凭据/备份均保守needs_review。同域成功重启不重复备份或DDL；已有合格且无COMMENT的旧列仍零DDL/零备份，不补COMMENT。此绑定不构成同一系统用户进程间的强身份认证；未发布旧候选形成的无COMMENT未知现场不接管，也不据此洗历史。迁移专用连接从不用于业务；cleanup未知不毒化原业务连接、不盲解锁/回滚/重放DDL。正常end ACK和Worker exit 0都确认才记录资源closed，否则保留资源归属与unknown回执且禁止再次迁移，不强杀。成片不可写时普通init不对project_renders执行CREATE；其它模块仍用未改变session/锁的原业务连接初始化和执行受控操作，目标表若仍有未知锁则相关操作仍可能受限。SQLite即使已回滚也保留真实失败/未知证据。前置失败不执行ALTER，安全摘要按backup_failed/unsupported_schema/busy/permission_denied/verification_failed/unknown_outcome六reason提供，needs_review是state，不是reason。

schema2 GET新增 `writable:boolean`、`details:null|{renderSchemaUpgrade:{state,reason}}`，仅只读投影，不写状态/备份/迁移。正常ready是true/null；未启动评估的旧库是required/unknown_outcome，需重启该实例升级。无法忠实构造成片DTO仍报原错误，不伪造link=null。默认schema1兼容原响应。writable缺失兼容旧后端，不能当所有按钮busy；后端每次关联/解除仍核实际schema、库身份、CAS和journal。

关联/解除的两schema错误，只有原项目/时间线/request/action/规范输入及数据库绑定均匹配且同journal已持久failed，才HTTP200返回原failed终态（含error.details安全摘要）。持久化失败、其它5xx、断连或未知原回执不包装成failed，不换requestId；原请求核对始终保留。

定向作者验证命令（仅全新自有数据）：`node --test tests/render-schema-startup.test.mjs tests/render-schema-http.test.mjs tests/render-startup-app.test.mjs`。原生MySQL专项必须显式运行 `node tests/render-startup-mysql-lock.check.mjs` 与 `node tests/render-startup-mysql-upgrade.check.mjs`，它们自建socket-only数据库并取得正常shutdown回执，不使用系统或现有库；不是普通npm test或CI的隐式依赖。另以`node tests/render-startup-mysql-app.check.mjs`自建全新loopback MySQL和合成库，通过测试入口注入一次迁移专用连接KILL故障（仅该自有连接），验证真实App可监听、成片待核/原ID失败回执以及项目HTTP创建/修改/列表持久化；所有服务正常关闭并保留证据，不为产品加入故障注入API。

离线 SQLite，先停止该库的写入并备份整个数据目录（包括完整原库、配置和媒体关联资料），再预演：

```sh
node server/project-renders.mjs migrate-sqlite /absolute/test-data/library.sqlite
node server/project-renders.mjs migrate-sqlite /absolute/test-data/library.sqlite --apply --backup /absolute/backups/renders-before-v2.json
```

第二条只有明确授权该库迁移后执行。备份文件必须不存在；写备份后再次比对源行，再 ALTER 并核对 payload 原字节及所有 revision=1。重复调用幂等；此离线工具不会被GET或普通init调用，App明确启动入口与它分离。程序化入口 `migrateRenderSchema(db,{apply,backupFile})` 同时生成 MySQL BIGINT 预演/执行语句；离线工具本身不因启动专项通过而获得真实库迁移授权，不能据此直接对现有库操作。

`ProjectRenders.snapshot/validateBackup/restoreRows` 提供严格、带版本的成片元数据导出/导入；schemaVersion=1 旧三列备份补 revision=1，v2 严格检查新列、payload、真实时间线与同项目 sourceId，不覆盖不同已有记录。视频备份继续使用原严格校验，可选 finalFolderId/mediaInfo 不放宽未知 keys；目录跨项目、removed、角色重叠均拒绝。恢复不恢复读取 approvals，所以相同路径也不自动授信。

代码回退前必须保留当前完整库及新增关系/后续写入。停写、导出当前成片元数据和数据库整备份，再决定保留 v2 表供恢复或在副本中转换。不能直接退代码/丢 revision/tombstone，也不能把迁移前备份覆盖到有后续写入的库。真实库迁移、数据恢复、合并和更新运行版需各自的明确授权。

隔离启动例（先创建自有目录，使用本机空闲端口）：

```sh
MEDIA_DATA_DIR=/absolute/test-data MEDIA_PERSONAL_ITEM_DIR=/absolute/test-media MEDIA_SKIP_IMPORT=1 MEDIA_CONTAINER=0 PORT=4518 MEDIA_DISABLE_DESKTOP_NATIVE=1 MEDIA_CODEX_AUTOCONNECT=0 node server/index.mjs
```

服务仅监听 127.0.0.1；测试应另加启动前的 loopback 护栏，禁止隐式/通配与现用端口，记录实际监听、正常 close 与资源清零。正常 SIGTERM 后以 APPLICATION_CLOSED_KNOWN 和已关闭 listener 为结清证据，不凭 PID 消失推断。测试仅使用合成媒体与空 SQLite；不调用真实模型/桌面，不操作真实 MySQL。
