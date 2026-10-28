# T13I 注入式协议 harness（round3）

本目录是 `T13I-PROTOCOL-HARNESS-20261024` **round3** 的测试代码，不是产品功能，不接入
`server/`、`src/`、`scripts/`、发行配置或依赖。目标是在不安装、不解包、不运行真实
发行引擎的前提下，用假 `lease / executor / probe` 走通现有产品合同，并把“真实执行
未授权”固定在入口 gate 上。

round3 只修独立审查 round2 的唯一剩余 P2：**fake 闭包仍保留调用方可变 constructor
options**。审查反例是构造 `createFakeExecutor({raw})` 后再给原 options 定义 `hang`
getter；round2 的 execute 闭包在运行时读取 `options.hang`，于是完整入口执行了调用方
getter 两次。

round3 的修法：

1. `fakes.mjs` 在构造时按 own data descriptor 校验并复制允许的选项到私有冻结配置；
   返回 fake 前完成 capture，之后闭包只读私有配置。
2. 不保留调用方 `options` 对象，也不 `Object.freeze()` 调用方对象（不偷换所有权）。
3. `descriptor` / `successExit` / `successStdio` / probe `result` 逐字段复制；构造后
   对原嵌套记录的 mutation 不生效。
4. 允许字段上出现访问器时构造期固定拒绝，且不执行 getter。
5. `raw` 只接受 `string` / `Buffer`；其它类型（number/object/array/null/symbol）构造期
   固定 `INVALID_REQUEST`，绝不 `String()`/`toString()`/`valueOf()`。Buffer 会复制。
6. `postconditionOverride` 是唯一“惰性记录”例外：只保留对象引用、绝不读字段，交给
   harness 的 own-data 读取拒绝访问器/缺字段，从而保留“坏 post 必须被拒绝”的夹具。
7. `methodAccessor` 的 getter 只递增 fake 私有计数，不执行调用方回调；可通过
   `executor.calls.accessorExecute` 观察（应为 0）。

信任边界不变：这里防的是**同进程受控对象被误替换/误访问器化**，不保证沙箱任意恶意
JS、Proxy 反射陷阱或同进程内刻意破坏。`postcondition` 仍是注入假 adapter 自报，不是
真实 OS 证据；拒绝路径的 `sideEffects=0` 只覆盖本实现实际经过的路径。

## 入口

```sh
# API
import { runProtocolHarness } from "./tests/t13i-protocol-harness/round3/harness.mjs";

# 自测（合成 fake + 临时目录）
node --test tests/t13i-protocol-harness/round3/harness.test.mjs

# 12 个 canonical 场景；只写调用方指定的 JSON
node tests/t13i-protocol-harness/round3/run-harness.mjs \
  --out collab/results/T13I-PROTOCOL-HARNESS-20261024/round3/harness.json
```

`runProtocolHarness(scenario, { lease, executor, probe })` 仍是唯一完整入口。gate 顺序与
round2 相同：scenario 读取走 own data descriptor → `mode=injected` → 拒绝真实执行/引擎
路径 → 拒绝真实 install → 拒绝预算改写 → 只接受私有 WeakMap membership 的冻结 fake →
adapter 容器/方法/postcondition 记录访问器拒绝 → 之后才创建临时目录/调用方法。

## 合同映射

| 合同 | 本 harness 的执行点 | 产品源码锚点 |
|---|---|---|
| 30s 单入口 + 180s 绝对上限 | `computeExecutorDeadline()`、`timing.executorWallLimitMs` | `server/audio-executor.mjs` `MAX_WALL_MS`、`#run` 的 `hardDeadline` |
| 64MiB FSIZE / CPU 180s / NOFILE 256 | `PROTOCOL_LIMITS` | `server/native/audio-executor-launcher.c` |
| 不追加 term/confirm allowance | `computeExecutorDeadline` 只取 min；`timing.allowanceAddedMs=0` | `audio-executor.mjs` `allowance` 用法 |
| descriptor 非零身份/匹配 | `validateDescriptor()` | `audio-engine.mjs` `#verifyRunDescriptor`、`withRunLease` |
| ffprobe expectedSha256 | `validateProbeTool()` | `audio-probe.mjs` `resolveAudioProbeTool`/`createAudioProbeToolConfig` |
| brief-v1 raw→normalized、warnings/duration/identity | 直接调用产品 `normalizeAudioResult` | `server/audio-result.mjs` `normalizeAudioResult`/`readContext` |
| 退出/job/自有进程组/dispose | `evaluatePostconditions()` + fake 自报 | `audio-executor.mjs` `#run` finally、`dispose` |

计时全部用 `createMonotonicClock()`（默认 `performance.now`）；记录 probe、lease
acquire/hold、execute、normalize、dispose、total，`allowanceAddedMs=0`。`installMs=0`
是“未执行”而不是“安装很快”。旧 256MiB 整 dataDir 预算保持 `approved=false`，本轮
没有 job-only/新上限。

## round3 定向测试

- 原审查反例 `probe-retained-options.mjs`（断言未改，仅 import 路径适配）：`getterCalls=0`、`code=OK`。
- 自测 `harness.test.mjs`：round2 的 26 项合同回归 + 6 项 round3 P2 定向
  （原反例、嵌套记录 mutation、嵌套访问器、非法 raw、Buffer 复制、lease/probe
  mutation 与构造值生效）。
- 12 canonical 场景、原 contracts 2 项、原 gate getter 0 次、预载副作用探针 0 事件。

不运行真实引擎/clang/ffprobe，不读真实音频/库/凭据，不联网，不安装/解包/下载，
不提交/推送/部署。自测不等于独立验收，也不等于 T13I 第 3 或整体 READY。
