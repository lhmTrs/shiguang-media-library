# 分镜视频绑定 v2 后端

公共结构见 `src/storyboard/video-binding-v2-types.ts`，合成响应见
`tests/fixtures/storyboard-video-v2/*.json`。服务入口先挂载
`/api/storyboard-video/v2`，再进入退役的旧视频业务路由；原项目视频上传及受保护媒体地址保留。

本模块区分生成前固定出处、当前视频绑定、当前采用和人工复核基准。
出处必须先预留，随后原上传请求携带 `storyboardOrigin`；上传 ready 回执与绑定结果应分别回读。
GET 只读取数据库及已有核验缓存，不扫描目录或探测媒体。绑定、预留、复核的媒体核验在事务外进行，落盘前在锁内重查文件及根目录身份。
外部调用方说明通过现有项目 Agent 指南追加；公开测试只使用独立编写的最小合成本机 API 调用方，不包含私有执行器或真实平台实现。

## 迁移和恢复边界

实际应用在监听前调用 `bindingV2.startup()`，数据库提供方切换后也调用同一入口。
按稳定的库实例和迁移版本升级一次：独立安装 schema → 在数据目录的私有目录导出 → 同步文件、读回并核摘要/计数/引用 → 锁内重核完整旧行集 → 三表逐 ID 删除、complete 标记及原请求回执同一事务。MySQL DDL 不在删除事务中。
同一数据目录使用可核验的原子 owner 文件串行；MySQL 还持有同实例会话 advisory lock。存活或无法核验的 owner 不会被抢占；只有已退出 PID 的完整 owner 记录可回收，不能通过杀进程完成升级。
私有阶段账本记录固定 requestId、阶段和导出摘要；中断重启沿用已核定输入，导出过期则停下，不换快照继续删除。已经完成后明确恢复的旧行也会暂停，不能靠重放原已提交请求删除第二次。

迁移失败、暂缓、尚未开始或结构不明时，生成视频列表与分镜只读接口继续可用，返回真实 `migration`。
`adoptionKnown=false` 时，采用集合、相关计数及修订为 null，表示未知；相关写入明确拒绝，历史裁剪暂停。GET 不安装 schema、不导出、不补基线、不清旧行。
`videoBindingMigration.historyPrune` 在分镜读取中显示暂停；项目视频列表保留原媒体播放地址。

### 按实例暂缓

数据目录下 `video-binding-v2/upgrade-policy.json` 是私有策略，包含 schemaVersion、instanceId、policyId、mode、reason、createdAt；实例必须精确匹配该目录既有 `mysql-source-id`。不按端口、电脑名或路径猜测身份。
策略在任何 schema/导出前读取，关键阶段再次核对；`defer` 不进入删除事务，非法或错实例策略停止升级。没有策略的普通库按默认自动升级。
下面是显式维护入口示例，数据目录和库实例必须由操作者明确给出；脚本不打开数据库、不读取连接凭据。检查为只读，更改已有策略须提供原 policyId，且保留私有审计记录。

```sh
node scripts/video-binding-v2-policy.mjs --check --data-dir /explicit/library/data --instance-id 'EXACT_INSTANCE_ID'
node scripts/video-binding-v2-policy.mjs --data-dir /explicit/library/data --instance-id 'EXACT_INSTANCE_ID' --mode defer --reason "Await explicit approval"
```

作者正式库接管前必须另获批准、落实并核验实例暂缓；本候选的实现或合并不授权读取/写入其真实配置、导出、DDL、删除或启动接管现用服务。

### 受控恢复

没有面向网页或 Agent 的迁移执行/策略修改接口。维护方法仍可用于获准的恢复：

- `migrationPreview()` / `checkMigration(exportedObject)`：只读计数、完整行集和原私有导出核对。
- `restoreLegacy(exportedObject,{requestId})`：只对原 complete 标记、同一摘要且三张旧表全空的状态精确恢复为 pending，不能覆盖后续旧行。
- `executeMigration(exportedObject,{requestId})`：必须使用与本次明确维护匹配的新请求；锁内核完整输入。不能把原已提交回执当新的恢复后删除授权。

视频来源、项目视频记录、读取授权和实际文件不属于删除集合。未知结果查询原 requestId；同 ID 不同输入冲突。
完整分镜备份通过版本化 `video_preview.video_binding_v2` 保存七表、原出处和事件；验证权威列身份、历史完整版、镜头索引和选择关系，恢复共享外层事务。

## 隔离验证

Node 22，FFmpeg/FFprobe 可用。合成媒体编码默认使用 PATH 的 ffmpeg，必要时设置 `VIDEO_V2_FFMPEG`。

```sh
node --test tests/storyboard-video-v2-*.test.mjs tests/storyboard-pending-version.test.mjs
npm run build
```

原生场是显式运行的独立脚本，不会被普通测试自动启动：

```sh
VIDEO_V2_OWNED_NATIVE=1 VIDEO_V2_MYSQLD=/absolute/path/to/mysqld node tests/storyboard-video-v2-native-mysql.mjs
```

该脚本仅创建自身临时 datadir、socket、PID 和回环临时端口，不使用 3306，不读取默认配置或作者凭据。使用自身控制连接正常 SHUTDOWN，核业务 worker 与服务退出；没有强杀回退。失败证据只留在其自有临时目录。
HTTP 测试使用自有数据目录、临时端口和模拟平台响应，并检查服务正常退出；不连接已安装生成器或真实任务。

这些是作者定向检查。前端组合、独立验收、真实 Windows 和发布状态分别记录，不能由这些命令推定。
