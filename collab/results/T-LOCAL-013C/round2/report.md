# T-LOCAL-013C Round 2：两处运行边界最小返工

- 日期：2026-10-23
- 工单：回复 GPT `#0087`（针对 `#0086` 首轮交付的返工）
- 范围：仅 `server/audio-engine.mjs`、`tests/audio-engine-runtime.test.mjs` 与本 `round2/` 产物
- 状态：GPT `probe-round1.mjs` **2/2 通过**；定向 runtime **9/9**、T12 安装器 **20/20**、默认冻结 **3/3**、`npm run build` 通过
- 未提交/推送/部署；未改云端源码/探针、未接真实素材/库/引擎、未启动服务、未下载/运行发行引擎

## 1. 修复 ①：运行前文件身份边界

原实现 `#loadRunRecord` 只读 `binaryStat.size`，没有保存 dev/ino/mtime/ctime；`#verifyRunDescriptor`
在 open 后只比较 size。因此在 lstat 与 open 之间把二进制换成“同内容、新 inode”的文件时，hash 仍然
相同、路径 lstat 也自洽，callback 被错误调用。

现改为：

- `#loadRunRecord` 用 **bigint lstat** 一次性取回 `dev/ino/size/mtimeNs/ctimeNs`，经
  `statIdentity()` 收敛为独立基本类型快照（不保存 `fs.Stats` 引用），存入 `record.binaryIdentity`；
- open 后立即 `handle.stat({ bigint: true })`，与 `record.binaryIdentity` 全字段比较；
- 流式 hash 完成后：再次 `handle.stat({ bigint: true })` 与路径 `lstat(..., { bigint: true })`
  都必须与 `record.binaryIdentity` 一致；
- 重新执行 `#loadRunRecord()` 复核 pointer/marker 时，除 generation/摘要/路径/发行摘要外，
  还要求新记录的 `binaryIdentity` 与首次记录一致；
- 任一处不一致固定 `ENGINE_INTEGRITY_FAILED`，不进入 callback，不泄露路径/原始异常，锁照常释放；
- 保留原有 `O_NOFOLLOW|O_NONBLOCK`、`isFile()`、hash 过程中 dev/ino/size/mtime/ctime 校验、
  FIFO 拒绝与 hash 中替换/原位修改保护。

## 2. 修复 ②：callback 错误边界

原 `#withRunLease` 的 catch 对 `AudioEngineError` 直接重抛，callback 可构造带私有路径的
message 或任意 code/status 透传。

现在 callback 调用统一经 `#invokeRunCallback`：

- 只允许列表内的固定 code：`ENGINE_RUN_FAILED`、`ENGINE_CANCELLED`；
- 允许的 code 也用 `new AudioEngineError(code)` 重建，使用默认文案与默认 status；
- 其它 `AudioEngineError`（含未知 code、自定义 status、私有 message）与普通异常/非 Error throw
  一律折叠为 `ENGINE_RUN_FAILED` 默认错误；
- 安装器内部错误（指针/路径/摘要/锁/取消）在 callback 边界之外，保持原固定码与 fail-closed 行为；
- `AudioEngineError` 构造器本身未改，旧调用方仍可自定义 message/status（兼容性未变）。

## 3. 新增回归

`tests/audio-engine-runtime.test.mjs` 新增 2 组（文件由 700 行增至 821 行）：

- **打开前换文件**：
  - open 前 `rename` 原文件并写入同字节的新 inode：`ENGINE_INTEGRITY_FAILED`、callback 0 次、锁释放，
    之后再次运行成功；
  - open 前同尺寸原位改写（内容不变，仅 mtime/ctime 变化）：同样拒绝且不调用 callback；
  - open 前把路径换成 FIFO：`O_NONBLOCK` 不挂起，fstat 非普通文件拒绝，恢复后运行成功。
- **callback 错误边界**：typed 私有路径、typed 未知 code、typed `ENGINE_CANCELLED`、普通 Error、
  非 Error throw 五类；断言 code 仅为允许列表、message 不含 `/private/` 与原始文案、status 为默认 400，
  每次失败后锁释放且下一次运行成功；并断言旧构造器仍保留自定义 message/status。

## 4. 证据

| 命令/对象 | 结果 | 日志 |
|---|---|---|
| 云端 `collab/reviews/T-LOCAL-013C/probe-round1.mjs`（未改） | **2/2 pass**；`{replaced:true,called:false,code:"ENGINE_INTEGRITY_FAILED"}`、`{code:"ENGINE_RUN_FAILED",leaked:false}` | `evidence/round2-gpt-probe.log` |
| `node --test tests/audio-engine-runtime.test.mjs` | **9/9 pass**，0 fail/skip（5.67s；原 7 + 新 2） | `evidence/round2-runtime.log` |
| `node --test tests/audio-engine-installer.test.mjs` | **20/20 pass**（T12 回归） | `evidence/round2-installer.log` |
| `node --test tests/audio-feature-flag.test.mjs` | **3/3 pass**，功能仍默认关闭 | `evidence/round2-freeze.log` |
| `npm run build` | 退出 0（tsc --noEmit + vite；仅既有 503.25kB chunk 警告） | `evidence/round2-build.log` |
| 两源码 + benchmark `node --check`、`git diff --check` | 退出 0 | `evidence/round2-syntax.log` |
| `collab/results/T-LOCAL-013C/benchmark.mjs`（8MiB 合成、回环 TLS） | verify 5.89/6.38/6.09ms（中位 6.09ms）；事件循环最大间隔 1.11ms；install BUSY 0.12ms、第二次租约 BUSY 0.02ms；abort→settle+释放 0.49ms；锁已释放 | `evidence/round2-benchmark.log` |
| round2 补丁可复现性 | baseline 打补丁后两文件 `cmp` 与当前一致 | `evidence/round2-patch-check.log` |

- `diff-round2.patch`：仅两文件、相对 round1 终态的最小 diff（321 行、12 个 hunk）。
- `baseline/`：由 round1 `diff.patch` 还原的 round1 终态，SHA256 与会话记录一致
  （engine `b6f298cf…d69d52`、runtime test `b3759469…16b02be`）。
- 当前 SHA256：engine `ffea6378433004dec316d0201b9a5f208bec5c215e629fbe51b12fbc490f0d44`（1609 行）、
  runtime test `e7f1fe6600280b421c218604ee4af5ecd14cab536d22ec8fd13f18dfa0498a38`（821 行）、
  diff `6807ed55…d909e869`。engine 现为 1609 行。
- 原 round1 `report.md`、`diff.patch`、`baseline/`、`logs/`、`results.json` 均保留未改。

## 5. 边界

只使用临时目录、合成小归档、回环 TLS 与合成进程；未运行发行引擎/真实音频，未访问真实素材/库/账户，
未连接 112.74.109.173，未操作 Docker/数据库，未部署/重启/提交/推送，未新增依赖。
