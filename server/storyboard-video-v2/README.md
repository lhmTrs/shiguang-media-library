# 分镜视频绑定 v2 后端

公共结构见 `src/storyboard/video-binding-v2-types.ts`，合成响应见
`tests/fixtures/storyboard-video-v2/*.json`。服务入口先挂载
`/api/storyboard-video/v2`，再进入退役的旧视频业务路由；原项目视频上传及受保护媒体地址保留。

本模块区分生成前固定出处、当前视频绑定、当前采用和人工复核基准。
出处必须先预留，随后原上传请求携带 `storyboardOrigin`；上传 ready 回执与绑定结果应分别回读。
GET 只读取数据库及已有核验缓存，不扫描目录或探测媒体。绑定、预留、复核的媒体核验在事务外进行，落盘前在锁内重查文件及根目录身份。
外部调用方说明通过现有项目 Agent 指南追加；公开测试只使用独立编写的最小合成本机 API 调用方，不包含私有执行器或真实平台实现。

## 迁移和恢复边界

只有全新空库自动安装 v2。已有项目、根目录或分镜的库不会因旧 source 表缺失而被当作新库。
已有库缺少或不能核清 v2 时返回 503；历史裁剪也停止，不能降级为空 pin 集合。
没有面向网页或 Agent 的迁移执行接口，应用启动不会清理旧绑定。以下均为持有该库对象后的受控维护方法，不是生产执行授权：

1. `bindingV2.migrationPreview()`：只读旧行计数、摘要和保留清单。
2. `bindingV2.installSchema()`：独立 DDL 阶段，标记 pending；不得把 MySQL DDL 当可回滚事务。
3. `await bindingV2.exportLegacy(privateDirectory)`：一致导出三张旧绑定表，0700 目录、0600 新文件、同步并读回检查；导出不进入 Git 或共享目录。
4. `bindingV2.checkMigration(exportedObject)`：核实例、计数、摘要、行结构和引用及当前完整行集。
5. `bindingV2.executeMigration(exportedObject,{requestId})`：锁内重查，只删除导出中的旧 takes/plans/requests；删除、complete 标记和原请求回执同一事务。
6. `bindingV2.restoreLegacy(exportedObject,{requestId})`：只对原 complete 标记、同一导出摘要且三表仍空的状态精确恢复，返回 pending；不覆盖后续旧行。恢复后的新执行使用新 requestId。

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
