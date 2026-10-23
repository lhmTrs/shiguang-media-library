# T-LOCAL-013C 交付报告：可信引擎描述符与运行租约

- 日期：2026-10-23
- 回复：`#0086`（引用 `#0085`）
- 工程：`/Users/luohongming/Desktop/作业/素材管理器`
- 结论：本地实现与隔离测试完成，**待 GPT 独立验收**；未提交、未推送、未部署、未连接正式服务器/账户、未运行发行引擎。

## 1. 修改范围

只改本地工程：

| 文件 | 变更 |
|---|---|
| `server/audio-engine.mjs` | 安装提交写入 v2 元数据；新增运行描述符校验与 `withRunLease`；运行/安装/卸载共用同一把排他 mkdir 锁；运行租约严格释放 |
| `tests/audio-engine-runtime.test.mjs` | 新增 7 组 T13C 定向测试（原文件不存在） |
| `collab/results/T-LOCAL-013C/` | 本报告、最小 diff、baseline、原始日志、基准脚本与结果 |

未改 `tests/audio-engine-installer.test.mjs`、`tests/audio-engine-fixtures.mjs`（与 baseline 逐字节一致），未改 index/Library/旧 audio-analysis/T13B 队列与快照/schema/HTTP/前端/发布 URL/hash/平台配置，未加依赖，未动 `scripts/qa.mjs` 的 T-LOCAL-001 补丁。

## 2. 安装元数据（v2）

`server/audio-engine.mjs` 在原有 TLS、归档大小/hash、解包边界校验全部通过后，于提交路径对 staging 中的实际二进制做 **256 KiB 分块流式 SHA256**（不使用 `readFile`），并检查 open 前后 dev/ino/size/mtime/ctime、实际读取字节数与 EOF、路径仍指向同一 inode。随后写入：

`versions/<dir>/.installed.json`：

```json
{
  "metadataVersion": 2,
  "version": "1.0.0",
  "releaseSha256": "<archive sha256>",
  "archiveBytes": 120156053,
  "binary": "audio-analyze",
  "binarySha256": "<actual binary sha256>",
  "binarySize": 12345678,
  "generation": "<32 hex, per commit>",
  "installedAt": "..."
}
```

`current.json` 同样写入 `metadataVersion`、`binarySha256`、`binarySize`、`generation`，并与 marker 逐字段一致。

- `generation` 每次真正提交用 `crypto.randomBytes(16)` 生成，不从调用方/HTTP 接收。
- 旧平铺安装或旧 marker（无 `metadataVersion` 或 `metadataVersion: 1`）保留 `status()` 兼容，但运行拒绝。
- 同版本安装的快速返回**只在**当前元数据为 v2 且非 legacy 时生效；旧元数据即使版本号相同也会走完整归档下载/校验/解包后重装。
- 为升级元数据而重装仍执行原有归档 SHA256/大小/解包校验，不能绕过。

## 3. 运行接口与固定错误码

新增内部方法（不接 HTTP/前端/队列）：

```js
await engine.withRunLease(async (descriptor, signal) => {
  // descriptor: frozen { version, platform, arch, releaseSha256,
  //             binarySha256, binarySize, generation, binaryPath }
  // signal: AbortSignal；同时带自引用 .signal，兼容 (descriptor, { signal })
  // 返回值/异常在 callback 真正 settle 后才返回；锁在 finally 才释放
}, { signal: externalAbortSignal });
```

执行顺序：

1. 校验 callback/signal；已取消则不进入 callback。
2. 只对 `enginesRoot` 做一次“存在且非链接”的预检，避免向链接目标写锁；随后用与安装/卸载相同的 `.audio-install.lock` **排他 mkdir** 抢锁。
3. 持锁读取 pointer/marker，校验 `enginesRoot → engineRoot → versionsRoot → versionDir → binary` 每级目录非链接，最终二进制为普通文件、大小有界、`dir`/`binary` 无逃逸。
4. 校验 pointer/marker/发行身份：version、platform、arch、releaseSha256 必须匹配当前内置 `this.release`；generation、binarySha256、binarySize 必须 pointer/marker/实际文件三方一致。**不把两个本地 JSON 互相一致当作发行身份校验**。
5. 以 `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` 打开最终二进制，fstat 必须为普通文件；按 256 KiB 分块流式 hash，期间检查取消信号。
6. hash 后复核：句柄前后身份/大小/mtime/ctime 不变、路径 lstat 仍同 inode、重新读取 pointer/marker 的 generation/摘要/路径未变；任一变化固定拒绝。
7. 冻结 descriptor 后调用 callback；callback reject/throw/取消都等其真正结束，再严格释放自有锁。

固定码（消息固定、无输入/路径/原始异常）：

| 码 | 含义 |
|---|---|
| `ENGINE_NOT_INSTALLED` | 尚未安装 |
| `ENGINE_REINSTALL_REQUIRED` | 旧平铺/旧元数据缺少可信摘要，需显式重装 |
| `ENGINE_RELEASE_MISMATCH` | pointer/marker 的版本或 releaseSha256 与内置发布不一致 |
| `ENGINE_INTEGRITY_FAILED` | 指针/marker/路径/文件身份/摘要/generation 校验失败 |
| `ENGINE_BUSY` | 同一 dataDir 的安装/卸载/运行锁被占用 |
| `ENGINE_LOCK_FAILED` | 抢锁或释放失败；释放失败时保留锁 |
| `ENGINE_CANCELLED` | 预取消或运行中取消 |
| `ENGINE_RUN_FAILED` | callback 的非引擎异常，已脱敏 |
| `ENGINE_INVALID_CALLBACK` | 非函数 callback 或非法 signal |

取消/生命周期契约：

- `AbortSignal.abort()`、`engine.cancel()`、`engine.dispose()` 对运行租约**只请求取消**，不 `Promise.race` 提前返回。
- callback 未 settle 时，第二次运行、`install()`、`uninstall()` 都得到 `ENGINE_BUSY`；锁保持。
- `dispose()` 是同步的，不会强制结束不合作的 callback，也不等待锁释放；调用方应 `await` 正在进行的 `withRunLease`。
- 释放只允许删除“只有本进程 `owner.json`”的锁目录；空锁、坏 owner、死 pid、未知条目一律保留并 fail-closed。`rmdir` 失败会恢复 owner 后返回 `ENGINE_LOCK_FAILED`。

## 4. 测试与证据

全部测试使用临时目录、随机回环 TLS、合成小归档/合成 8 MiB 文件；不访问生产、不下载/运行发行引擎、不碰真实素材/库。

| 套件 | 结果 | 日志 |
|---|---|---|
| `tests/audio-engine-runtime.test.mjs` | **7/7 pass** | `logs/runtime.log` |
| `tests/audio-engine-installer.test.mjs`（T12 回归） | **20/20 pass** | `logs/installer.log` |
| `tests/audio-feature-flag.test.mjs`（默认冻结 3 项） | **3/3 pass** | `logs/feature-flag.log` |
| `npm run build` | exit 0 | `logs/build.log` |
| `node --check` + `git diff --check` | exit 0 | `logs/syntax.log` |

复跑命令：

```bash
node --test tests/audio-engine-runtime.test.mjs
node --test tests/audio-engine-installer.test.mjs
node --test tests/audio-feature-flag.test.mjs
npm run build
node collab/results/T-LOCAL-013C/benchmark.mjs
```

覆盖的定向场景：

1. 新安装 v2 元数据字段/真实 hash/generation；descriptor 字段、冻结、路径仅内部；status/getter 不联网/不写锁/不改文件。
2. 旧 marker（含 `metadataVersion: 1` 与无版本字段）status 兼容、运行 `ENGINE_REINSTALL_REQUIRED`；同版本显式重装升级且不被快速返回挡住；归档 hash 错误时升级失败且旧平铺安装保留。
3. 同长度篡改、pointer/marker 错误摘要、伪造发行身份、generation 冲突、平台不符。
4. versions 符号链接、FIFO 替换、hash 期间 rename 替换、原位改写、hash 期间替换 pointer generation。
5. 运行持锁 vs install/uninstall/第二实例/独立 Node 子进程；双向持锁竞争；释放后恢复。
6. callback 同步 throw/异步 reject/缺失参数/预取消/运行中 Abort/`cancel()`/`dispose()` 等待。
7. 未知锁条目、坏 owner、`unlink`/`rmdir` 释放失败、死 pid 锁保留。

## 5. 隔离基准（`logs/benchmark.log`）

合成 8 MiB 随机二进制，本地回环 TLS 安装；`withRunLease` 含抢锁、元数据/路径校验和全量流式 SHA256，不含 callback：

| 指标 | 结果 |
|---|---|
| 二进制大小 | 8,388,608 B |
| hash 分块 | 256 KiB |
| verify 样本 | 5.11 / 5.27 / 4.53 ms；中位 5.11 ms |
| 安装总耗时（含回环下载/解包/提交 hash） | 62.28 ms |
| hash 期间事件循环最大间隔 | 1.06 ms |
| 持锁时 `install()` BUSY | 0.08 ms |
| 持锁时第二次 `withRunLease` BUSY | 0.01 ms |
| abort → 真正 settle + 锁释放 | 0.50 ms |
| 锁释放 | yes |

计时边界：`verifyMs` 从调用到 descriptor 交付；`cancelToSettledMs` 是 AbortController.abort 到 reject + 锁删除的合成等待，**不是真实音频分析性能**；所有数字均为合成文件/回环，不代表公网或真实引擎。

## 6. 已知限制（不冒称）

- 安装记录不是数字签名；本项防意外损坏、路径替换及应用内安装/执行竞争，**不宣称**能抵抗拥有同一 OS 用户写权限、可同时篡改元数据与二进制的恶意者。
- 没有 OS 级网络/资源沙箱；`withRunLease` 自身不 spawn，未接真实执行器/队列/结果表；真实引擎协议、进程组回收、RSS/网络限制仍属后续 T13A/正式执行器范围。
- `dispose()` 只请求取消，不强制结束不合作的 callback；锁会一直保留到 callback settle 或维护者按 T12 契约处理。
- 空锁/坏 owner/死 pid/未知条目继续按 T12 保守策略 **不自动回收**，需维护者确认后手动清理。
- 同版本已安装且 v2 元数据有效时，`install()` 仍按 T12 契约快速返回，不在同步调用内重新 hash 现有二进制；被篡改文件由运行前校验拒绝，修复需卸载/重装（或使元数据失效后重装）。
- 严格释放通过 `readdir` 只允许 `owner.json` 后 `unlink` + `rmdir`；同一 OS 用户同时替换锁目录的极端 TOCTOU 不在本项可完全消除范围，但正常/竞态路径均 fail-closed。

## 7. 产物与校验

- 最小 diff：`collab/results/T-LOCAL-013C/diff.patch`
- baseline：`baseline/audio-engine.mjs`、`baseline/audio-engine-installer.test.mjs`、`baseline/audio-engine-fixtures.mjs`
- 代码 hash：`code.sha256`
- 基准脚本：`benchmark.mjs`

`code.sha256` 当前包含：

```text
b6f298cfba700266667c365a52f6739cf7a67a7939b462b029787aa806d69d52  server/audio-engine.mjs
b375946974979ff4d26e5775ceb4ab667e58dafdb87040df521a8eaed16b02be  tests/audio-engine-runtime.test.mjs
8a07ab816c82c1b9cf895aa5bb36be1459a7788b6f5e51962befb58cb9655123  collab/results/T-LOCAL-013C/benchmark.mjs
4c67e546815f23fe1a45805af7d5768bb12ab6f733a080f2b514e19d458c281c  tests/audio-engine-installer.test.mjs
ad08ff4ed2cecb946cf35cd8007459c86f78ff7e971e50ab4c7f5a2420ac2230  tests/audio-engine-fixtures.mjs
```
