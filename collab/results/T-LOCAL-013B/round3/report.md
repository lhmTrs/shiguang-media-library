# T-LOCAL-013B Round 3：创建阶段 marker 半写失败清理

- 日期：2026-10-23
- 工单：回复 GPT `#0082`（针对 `#0081` round2 的剩余分支）
- 范围：仅 `server/audio-snapshot.mjs`、两个对应测试与本 `round3/` 证据
- 状态：GPT 新 probe **1/1 通过**；原三 probe **3/3**；定向 **32/32**、默认冻结 **3/3**、`npm run build` 通过
- 未提交/推送/部署；未改云端源码/探针、未接真实素材/库/引擎、未启动服务

## 1. 剩余分支修复（`server/audio-snapshot.mjs`）

#0080② 的 round2 修复只覆盖了“marker 已完整写入后”的 `removeOwnedDir` 路径。创建阶段
`fs.writeFile(.owner.json)` 在写入部分字节后抛 `ENOSPC` 时，`markerWritten` 仍为 `false`，
原代码执行 `fs.rmdir(dir).catch(() => {})`，把 `ENOTEMPTY` 吞掉，随后返回
`SNAPSHOT_FAILED`；队列因此认为清理完成并释放租约，留下 1 个残留任务目录。

现在：

- 新增 `removeIncompleteDir(base, dir)`，只在“本进程刚排他 `mkdir` 创建、目录内除
  `.owner.json` 外没有其它条目”时回收；
- 先 `readdir` 核对目录内容，出现任何未知条目立即 `CLEANUP_FAILED`，保留现场；
- 只 `unlink` 本任务固定路径的未写完 marker，再非递归 `rmdir`；不递归删除目录、
  不删除未知内容，也不放松 `removeOwnedDir` 的 token 归属校验；
- `rmdir` 失败或目录仍存在时抛 `CLEANUP_FAILED`，不再吞错；
- 该错误沿既有队列路径进入 `#leaseBroken`：终态 `failed CLEANUP_FAILED`、
  `busy=true`、租约保留、后续任务不启动，且优先于 `CANCELLED/TIMEOUT`。

因此半写 marker 有两种可接受结果：能安全清干净时受控失败并释放；清不干净时
`CLEANUP_FAILED` 并保留租约/busy。不会出现“有残留却释放”。

## 2. 新增回归

`tests/audio-snapshot.test.mjs` 新增 2 项：

- marker 写入半段后抛 `ENOSPC`：受控 `SNAPSHOT_FAILED`，且不留下 `job-*` 目录。
- marker 半写且 `rmdir` 失败：受控 `CLEANUP_FAILED`，保留 1 个自有残留目录。

`tests/audio-job-queue.test.mjs` 新增 1 项：

- marker 半写 + `rmdir` 失败 + 取消交错：`failed CLEANUP_FAILED`（取消不能覆盖）、
  租约在、`busy=true`、执行器 0 次、后续任务保持 `queued`、`dispose` 后租约仍在
  且残留目录仍为 1。

## 3. 证据

| 命令/对象 | 结果 | 日志 |
|---|---|---|
| `node --test tests/audio-job-queue.test.mjs tests/audio-snapshot.test.mjs` | **32/32 pass, 0 fail, 0 skipped**（917.9ms；原 29 + 新 3） | `round3/evidence/round3-new-tests.log` |
| GPT `probe-partial-marker.mjs`（云端只读，本侧未改） | **1/1 pass**；`state=failed code=SNAPSHOT_FAILED busy=false residual=0 lease=false`（已真正清干净） | `round3/evidence/round3-gpt-probe-partial-marker.log` |
| GPT `probe-round1.mjs`（云端只读，本侧未改） | **3/3 pass**；短写 131072/131072 hash 一致；创建清理故障 `CLEANUP_FAILED busy=true lease=true residual=1`；可变基线 `SOURCE_CHANGED` | `round3/evidence/round3-gpt-probe-round1.log` |
| `node --test tests/audio-feature-flag.test.mjs` | **3/3 pass**，六条音频路由仍 503，`net=0 process=0 sql=0` | `round3/evidence/round3-freeze.log` |
| `npm run build` | 退出 0（tsc --noEmit + vite，858ms） | `round3/evidence/round3-build.log` |
| `node --check` 四文件 | 通过 | `round3/evidence/round3-syntax.log` |
| `round3/baseline/` + `diff-round3.patch` | 三个改动文件打补丁后与当前 `cmp` 一致 | `round3/evidence/round3-patch-check.log` |

按 `#0082` 要求未重复无关安装器全量回归。原 round1/round2 的 `diff.patch`、`report.md`、
`evidence/` 与 `round2/` 均保留未改。

## 4. 当前文件与 SHA256

- `server/audio-snapshot.mjs`：412 行，`ae2747b4…13f2a3fb`
- `server/audio-job-queue.mjs`：583 行，未改，`6a2b5d35…a770d3c939`
- `tests/audio-snapshot.test.mjs`：414 行，`2def0128…881a5d7a`
- `tests/audio-job-queue.test.mjs`：725 行，`519b6288…553797a0`
- `round3/diff-round3.patch`：仅三个改动文件，`1381b90c…3372a353`

## 5. 边界与限制

- 仍默认关闭；未接 HTTP/jobs 路由、DB/schema/saving、媒体 probe、真实引擎
  descriptor/launcher/安装器运行租约、前端。
- 未运行发行引擎/真实素材/真实音频协议；未连 112.74.109.173、未操作 Docker/
  数据库/正式账户；未安装软件、未读取/打印密钥。
- 未改 `scripts/qa.mjs` 的 T-LOCAL-001 补丁；未提交/推送/部署。
