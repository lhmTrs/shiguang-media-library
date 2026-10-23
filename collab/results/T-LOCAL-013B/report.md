# T-LOCAL-013B：分析任务队列与有界文件快照

- 日期：2026-10-23
- 工单：回复 GPT `#0078`，按 `拾光云端后台/collab/specs/T-LOCAL-013B.md` 实施（规格只读）
- 状态：隔离后端核心完成；新定向 **23/23**、默认冻结 **3/3**、T12 安装器回归 **20/20**、`npm run build` 通过
- 环境：macOS Darwin 24.6.0 / arm64 / Node v22.7.0
- 位置：`素材管理器/server/audio-job-queue.mjs`、`server/audio-snapshot.mjs`、两个新测试、本目录证据
- 未接：`server/index.mjs`、旧 `audio-analysis.mjs`、Library、安装器、T13A 原型、schema、前端、启动环境；默认关闭，未提交/推送/部署

## 1. 结论先说

本轮交付两个**源码级可复用模块**，不在默认启动路径导入或实例化，不需要新依赖：

| 文件 | 行数 | SHA256 |
|---|---:|---|
| `server/audio-job-queue.mjs` | 556 | `5a61d0d5c5fd52c02a020c5aa9cf02c83b1c75a5c5ad5fc65b32be26b3848133` |
| `server/audio-snapshot.mjs` | 358 | `c5d1f088995b54b3726ed1a184177b1de2a15172053241670e6c8f7158e92996` |
| `tests/audio-job-queue.test.mjs` | 591 | `57fd721ac9dc3671c0469d7a714e47a26a91fafb8b4a88e7bd4a806962f06ed3` |
| `tests/audio-snapshot.test.mjs` | 259 | `72eb5b960256e527f89703e0ad46ca48fd72d1954370a45098de7566f7e75fcc` |

最小 diff：`diff.patch`（四个新文件 vs `/dev/null`，未改任何既有文件）。

本轮**不声称**：HTTP 202/短轮询、DB 保存事务、`saving` 状态、成功结果缓存、媒体时长/采样率/声道 probe、真实引擎协议、安装器运行租约集成、OS 网络/资源沙箱、崩溃后自动恢复。上述均留给后续工单。

## 2. 队列接口与状态

### 2.1 构造与注入

```js
const queue = new AudioJobQueue({
  dataDir,                 // 租约/任务目录都在 <dataDir>/audio-jobs/
  resolveAsset(assetId),   // 可信内部解析器，返回下方固定字段
  execute(snapshot, { signal }), // 注入执行器；本项测试用合成实现
  wallDeadlineMs: 180_000, // 测试可缩短
  maxWaiting: 8,
  maxTerminal: 100,
  terminalTtlMs: 24 * 60 * 60 * 1000,
  maxSnapshotBytes: 256 * 1024 * 1024,
});
```

`submit(assetId, { force? })` / `get(jobId)` / `cancel(jobId)` / `dispose()`；只读 `queue.busy`。

- `submit` 严格校验：`assetId` 非空字符串；options 只能是普通对象，唯一允许字段 `force`，且必须是**严格 boolean**。未知字段、字符串 `"true"`、null、数组都返回固定 `INVALID_REQUEST`。
- `get/cancel` 对未知 job 固定 `JOB_NOT_FOUND`，不伪造成功。
- 构造、`get`、`busy` 不写锁；只有 worker 真正开始执行任务时才获取租约。

### 2.2 固定 resolver 字段

测试中固定为：

```js
{
  assetId, kind: "music" | "sfx",
  sourcePath, rootPath, rootId,          // 绝对路径
  online, trashed, retired, rootRetired, busy, // 严格 boolean
  assetGeneration, libraryGeneration, sourceGeneration // string 或安全整数
}
```

入队、worker 开始、快照后、执行完成前都重新解析并逐字段比对。`kind` 非 music/sfx、离线、废纸篓、素材/根注销、`busy`、generation 或路径变化均受控失败，不返回旧成功。resolver 抛错只透传 `ASSET_NOT_FOUND`/`ASSET_BUSY`，其它归并为 `RESOLVER_FAILED`。

### 2.3 状态与并发

- 状态：`queued → validating → snapshotting → running → succeeded`；失败 `failed`；取消先 `cancelling`，execute settle + 清理后 `cancelled`。
- 只有阶段信息与排队位置，无百分比。
- 单 worker；运行 1 个 + 等待最多 8 个。队满 `AUDIO_QUEUE_FULL`。
- 同一 `assetId` 非终态合并为同一 job，`force:true` 也不制造重复任务；**成功后新提交**必须重新 resolve、重新生成快照（不实现成功结果持久缓存）。
- 终态最多 100 条、最长 24h，只在 submit/get/cancel/任务结束时惰性清理，无常驻轮询。
- `dispose()` 取消排队与活跃任务，等待 execute settle、快照清理后返回；之后 `submit` 固定 `QUEUE_DISPOSED`。不自动恢复队列。

### 2.4 独立运行租约

- 路径：`<dataDir>/audio-jobs/.queue-lease`，与 T12 的 `engines/.audio-install.lock` 完全独立。
- 用排他 `mkdir` 抢锁；任何已存在锁（含空目录、owner 缺失/不可校验、旧进程已死）一律 `AUDIO_ENGINE_BUSY`，**不按 pid/时间自动回收**。
- `owner.json` 用 `wx` 0600 写入；写 owner 失败只回收本进程刚建且仍无 owner 的空目录。
- 释放前核对 token + `purpose:"audio-job-queue"`；不匹配则 `LEASE_RELEASE_FAILED`，保留锁。
- 每个任务执行结束、快照清理完成后释放；两个实例不会同时执行，但可在前一实例释放后接力。

### 2.5 取消、超时与错误

- queued 取消立即移出等待队列并 `cancelled`。
- validating/snapshotting/running 取消：置 `cancelling` 并向内部 `AbortController` 发信号。
- 必须等 execute settle、快照清理完成后再公布 `cancelled` 并释放租约；不是 `Promise.race` 后放旧任务后台跑。
- 成功/取消竞争：已公布 `succeeded` 后 cancel 不改结果；最终校验前的取消不会被旧成功覆盖。
- wall deadline 默认 180s（测试 100—1000ms），到点 abort 并等 settle；超时终态 `TIMEOUT`。
- 错误只带固定 code + 短消息；resolver/execute 异常原文、私人路径、stderr、命令、输入内容都不进入 job 摘要。

固定错误码：`INVALID_REQUEST`、`JOB_NOT_FOUND`、`ASSET_NOT_FOUND`、`QUEUE_DISPOSED`、`AUDIO_QUEUE_FULL`、`AUDIO_ENGINE_BUSY`、`AUDIO_LEASE_FAILED`、`LEASE_RELEASE_FAILED`、`ASSET_BUSY`、`SOURCE_OFFLINE/TRASHED/RETIRED`、`ROOT_RETIRED`、`SOURCE_CHANGED`、`UNSUPPORTED_ASSET`、`RESOLVER_FAILED`、`SNAPSHOT_FAILED`、`EXECUTION_FAILED`、`TIMEOUT`、`CANCELLED`、`CLEANUP_FAILED`；快照侧另有 `SOURCE_MISSING`、`SOURCE_NOT_REGULAR`、`SOURCE_OUTSIDE_ROOT`、`SOURCE_UNREADABLE`、`INPUT_LIMIT_EXCEEDED`。执行器自报的 `TIMEOUT/OUTPUT_LIMIT/INVALID_OUTPUT/ENGINE_FAILED/RESOURCE_LIMIT/CANCELLED` 按固定码透传（`CANCELLED` 归入取消终态）。

## 3. 快照语义

`createSnapshot({ dataDir, rootPath, sourcePath, maxBytes, signal, jobId })`：

1. **边界**：realpath 登记根与目标，复用 `fs-identity.within`；拒绝同名前缀目录（如 `media-evil`）、根外目标、逃逸链接。目标最终组件必须是普通文件，目录/FIFO/字符设备/最终符号链接拒绝。
2. **打开前复核**：`O_RDONLY|O_NOFOLLOW|O_NONBLOCK` 打开后 `fstat`，要求 `isFile()` 且 dev/ino/size/mtime/ctime 与打开前 lstat 一致；验证后被换成 FIFO 不会挂死，换成另一个普通文件报 `SOURCE_CHANGED`。
3. **有界流**：私有任务目录 `0700`、快照文件 `0600` 且 `O_EXCL`；单次 64KiB 读循环同时写副本和更新 SHA256，不 `readFile` 整文件。默认上限 256MiB，测试更小；实际字节计数独立检查，不信初始 stat 或数据库旧 hash。
4. **前后身份**：复制前后核对打开的 fd 与路径的 dev/ino/size/mtime/ctime，且路径 realpath 仍指向同一对象；复制中增长、同尺寸改写、rename 替换都报 `SOURCE_CHANGED`，并清理自有副本。
5. **清理归属**：任务目录内 `.owner.json` 记录随机 token；清理前校验 token 与目录位于 `<dataDir>/audio-jobs/` 内，只递归删除该目录。共享根、未知目录、其它任务目录不删；token 不匹配报 `CLEANUP_FAILED` 并保留目录。清理失败时队列不释放租约、不启动下一项。
6. **空文件策略**：明确允许 0 字节普通文件，快照 0 字节、SHA256 为 `e3b0c442...`；不把空文件误判为特殊文件。

## 4. 独立证据

### 4.1 测试与构建

| 命令 | 结果 | 原始日志 |
|---|---|---|
| `node --test tests/audio-job-queue.test.mjs tests/audio-snapshot.test.mjs` | **23/23 pass, 0 fail, 0 skipped**，769.8ms | `evidence/new-tests.log` |
| `node --test tests/audio-feature-flag.test.mjs` | **3/3 pass**（默认六条音频路由冻结） | `evidence/freeze.log` |
| `node --test tests/audio-engine-installer.test.mjs` | **20/20 pass**（T12 回归未受新文件影响） | `evidence/installer.log` |
| `npm run build` | `tsc --noEmit` + vite 成功 | `evidence/build.log` |

覆盖矩阵（23 项）：

- 单 worker、8 等待上限、队满、同 asset/force 合并、完成后重新 resolve/新快照、未知 job、严格输入。
- 排队取消、复制阶段取消、执行取消、超时、先失败后下一项、成功/取消交错、dispose 等待完整清理。
- 登记根外/同名前缀/逃逸链接、目录/FIFO 拒绝、打开前换 FIFO/换普通文件、复制中增长/同尺寸改写/rename 替换、真实流式 hash、合法空文件。
- 文件删除、online/trashed/retired/rootRetired/busy/library/source generation 变化；完成前失效不返回旧成功。
- 任务目录/租约清理、未知目录保留、摘要与错误不含绝对路径/原始 stderr、两个实例竞争、清理失败保留租约。

### 4.2 合成计时

命令：`node collab/results/T-LOCAL-013B/benchmark.mjs`；原始输出 `evidence/timing.log`、`evidence/timing.json`。

- 夹具：8MiB 合成随机文件，SHA256 `04b23c49...d42d97`。
- 直接快照复制 12.61ms、清理 1.42ms；hash 与源一致。
- 队列 submit 0.08—0.75ms（短响应）；正常端到端 37.88—44.46ms（含合成 executor 25ms sleep）。
- 运行中取消到 `cancelled` 36.47ms；`maxConcurrent=1`；结束时残留任务目录 0、租约 false。

**这些是合成 executor 的队列/快照开销，不是真实引擎性能。** 未运行发行引擎、真实素材、真实音频协议。

## 5. 复跑命令

```bash
cd 素材管理器
node --test tests/audio-job-queue.test.mjs tests/audio-snapshot.test.mjs
node --test tests/audio-feature-flag.test.mjs
node --test tests/audio-engine-installer.test.mjs
node collab/results/T-LOCAL-013B/benchmark.mjs
npm run build
```

## 6. 边界与未验证项

- 未新增/修改 `server/index.mjs` 路由、`audio-analysis.mjs`、`Library`、安装器、T13A 原型、schema、前端、`.env`、启动脚本；没有默认启用 `SHIGUANG_AUDIO_ANALYSIS`。
- 无 DB 写入、无 `asset_audio` DDL、无结果保存事务；`saving` 状态与旧 job 无法回写 DB 的回滚语义不在本项。
- 执行器、媒体 probe、可信引擎 descriptor/launcher、安装器运行租约集成均未接入；`execute` 仍为注入的合成实现。
- 没有 OS 网络隔离或硬内存限制；本模块只做进程执行边界之外的队列/快照，不宣称沙箱。
- 不作为崩溃恢复：租约残留需人工确认后清理，不按时间盲删；服务重启后队列不自动恢复。
- 未提交、未推送、未部署、未连正式云端账户、未操作正式服务器/Docker/数据库；T-LOCAL-001 的 `scripts/qa.mjs` 既有补丁未改动。

## 7. 需要 GPT 独立验收

请重点复核：

1. 两个实例竞争时“每任务持锁/释放”的粒度是否满足你定义的运行租约；残留锁是否严格 fail-closed。
2. 快照前后身份/路径复核是否足以覆盖“验证后被换 FIFO/普通文件/复制中替换”，以及空文件策略。
3. 清理失败保留租约、不启动下一项的 fail-closed 行为是否符合验收预期。
4. job 摘要/错误是否还有路径或原始错误泄露面。
