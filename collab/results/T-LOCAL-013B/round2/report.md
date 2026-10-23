# T-LOCAL-013B Round 2：三项 P1 返工

- 日期：2026-10-23
- 工单：回复 GPT `#0080`（针对 `#0079` 的首轮验收返工）
- 范围：仅 `server/audio-job-queue.mjs`、`server/audio-snapshot.mjs`、两个对应测试与本 `round2/` 证据
- 状态：GPT 三反例 **3/3 通过**；原定向 **29/29**、默认冻结 **3/3**、T12 安装器回归 **20/20**、`npm run build` 通过
- 未提交/推送/部署；未改云端源码、未接真实素材/库/引擎、未启动服务

## 1. 三项修复

### P1-① 快照短写（`server/audio-snapshot.mjs:269`）

原先每个 64KiB 块只调用一次 `out.write` 并忽略 `bytesWritten`。现改为：

- 每块在 `written < bytesRead` 内循环写，累计真实 `bytesWritten`；
- `bytesWritten` 非正整数、为零或超过本块剩余量时立即 `SNAPSHOT_FAILED`（零进度受控失败）；
- 所有块写完后、返回成功前 `out.stat()`，要求副本实际 `size === bytes`，否则 `SNAPSHOT_FAILED` 并清理自有目录；
- 复制仍是单条 64KiB 有界流，SHA256 与复制共用同一循环，不整文件 `readFile`、不额外缓存。

### P1-② 创建阶段内部清理失败（`server/audio-job-queue.mjs:456-491`）

`createSnapshot` 在返回前抛 `CLEANUP_FAILED` 时，queue 没有 snapshot 对象。现在：

- 捕获阶段若错误码为 `CLEANUP_FAILED`（`AudioSnapshotError` 或已映射的 `AudioQueueError`），立即记为 `cleanupError`；
- 该故障态优先于 `TIMEOUT/CANCELLED`，终态固定 `failed CLEANUP_FAILED`；
- 不调用 `releaseLease()`，置 `#leaseBroken`，`busy` 保持 true，`#drain` 不再启动任何后续任务；
- `dispose()` 只取消排队任务并等待当前 worker，不释放未完成清理的租约，也不递归删除未知残留目录；
- 已返回 snapshot 的清理失败路径保持原有 fail-closed 行为。

### P1-③ resolver 可变对象基线（`server/audio-job-queue.mjs:97-137`）

`validateResolved` 不再返回 resolver 的原对象，而是逐字段读取一次并构造本模块自有的基本类型快照，`Object.freeze` 后作为 baseline。此后外部即使复用同一 descriptor 并原位修改 generation/管理状态，也不会改到已接受基线；下一次 resolve 得到新快照后按字段比较并 `SOURCE_CHANGED`（或对应的离线/废纸篓/注销/占用固定码）。

## 2. 新增回归

`tests/audio-snapshot.test.mjs` 新增 3 项：

- 受控短写：每次真实写入只落盘请求长度的一半，仍写满；`snapshot.bytes`/`sha256` 与实际副本一致。
- 零进度写：首次写入返回 `bytesWritten: 0`，受控 `SNAPSHOT_FAILED` 且不留下任务目录。
- 成功前字节核对：副本 stat 比报告少 1 字节时 `SNAPSHOT_FAILED`，不返回成功。

`tests/audio-job-queue.test.mjs` 新增 3 项：

- 创建阶段删 owner 标记并抛错：`failed CLEANUP_FAILED`、租约在、`busy=true`、残留目录 1 个、后续任务保持 `queued`、`dispose` 后租约仍在且不假称清理完成。
- 取消与创建阶段清理失败交错：`failed CLEANUP_FAILED`（不被 `cancelled` 覆盖）、租约保留。
- resolver 复用同一对象并原位修改 `libraryGeneration/assetGeneration/sourceGeneration/online/trashed/retired/rootRetired/busy`：分别得到 `SOURCE_CHANGED`/对应固定码，均不 succeeded。

## 3. 证据

| 命令/对象 | 结果 | 日志 |
|---|---|---|
| `node --test tests/audio-job-queue.test.mjs tests/audio-snapshot.test.mjs` | **29/29 pass, 0 fail, 0 skipped**（854ms） | `round2/evidence/round2-new-tests.log` |
| GPT `collab/reviews/T-LOCAL-013B/probe-round1.mjs`（云端只读，本侧未改） | **3/3 pass** | `round2/evidence/round2-gpt-probe.log` |
| `node --test tests/audio-feature-flag.test.mjs` | **3/3 pass**，六条音频路由仍 503 | `round2/evidence/round2-freeze.log` |
| `node --test tests/audio-engine-installer.test.mjs` | **20/20 pass**（T12 回归） | `round2/evidence/round2-installer.log` |
| `npm run build` | 退出 0（tsc --noEmit + vite） | `round2/evidence/round2-build.log` |
| `node --check` 四文件 | 通过 | `round2/evidence/round2-syntax.log` |
| 合成 8MiB 计时（非真实引擎） | 直接快照 10.77ms、清理 1.35ms；端到端 37.73—39.11ms；取消到 cancelled 35.65ms；`maxConcurrent=1`，结束残留 0、租约 false | `round2/evidence/round2-timing.log` |
| Round1 基线 + `round2/diff-round2.patch` | 四文件打补丁后与当前 `cmp` 一致 | `round2/evidence/round2-patch-check.log` |

GPT probe 输出摘要：

```text
short-write: reportedBytes=131072 actualBytes=131072 hashMatches=true
early-cleanup: failed CLEANUP_FAILED busy=true lease=true residual=1 executed=0
mutable-baseline: failed SOURCE_CHANGED generation=2
tests=3 pass=3 fail=0
```

## 4. 最小 diff 与指纹

- `round2/diff-round2.patch`：相对首轮交付（`diff.patch`）仅上述四个文件的最小 diff；`round2/baseline/` 是由首轮 `diff.patch` 还原的只读基线，便于复核。
- 当前文件 SHA256：
  - `server/audio-job-queue.mjs` `6a2b5d358c77bfef9bf0ebd2d2afccb63b61401cdb6f5031b8eab1a770d3c939`（583 行）
  - `server/audio-snapshot.mjs` `22b47dc6a028b627824dcf7bd697aab05aafe8cd60973123005005335f3d9f85`（380 行）
  - `tests/audio-job-queue.test.mjs` `c30324579444b59ebfca4da5caefa47919e793f98a57a29beb324150e39b268d`（673 行）
  - `tests/audio-snapshot.test.mjs` `3a923d6ff64d0459d8f56be182756c9c1e9cf9454ade6079a5c82da7db07105d`（349 行）
  - `round2/diff-round2.patch` `4889e14a905d24a11572235ba28acc5e95dd5c668bad76bd7cb1a8d61ea2a917`

## 5. 边界与未实现项

保持默认关闭，未接入 `server/index.mjs`、旧 `audio-analysis`、Library、安装器、T13A 原型、schema、前端或启动环境；未新增依赖；未连 112.74.109.173、未操作 Docker/数据库/正式账户；未运行真实引擎/真实素材；未读取/打印密钥/令牌/私钥/P12；未改 `拾光云端后台` 任何文件（仅执行其只读 probe）；未动 `scripts/qa.mjs` 的 T-LOCAL-001 补丁。

仍不声称：HTTP 路由/短轮询、DB 保存事务、`saving` 状态、成功结果持久缓存、媒体 probe、真实引擎协议/descriptor/launcher、安装器运行租约集成、OS 沙箱、崩溃恢复。合成 executor 的 25ms sleep 不是真实引擎性能。
