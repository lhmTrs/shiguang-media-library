# T13I 注入式协议 harness（round4）

本目录是 `T13I-PROTOCOL-HARNESS-20261024` **round4** 的测试代码，不是产品功能，不接入
`server/`、`src/`、`scripts/`、发行配置或依赖。目标仍是在不安装、不解包、不运行真实
发行引擎的前提下，用假 `lease / executor / probe` 走通现有产品合同，并把“真实执行
未授权”固定在入口 gate 上。

round4 只修独立审查 round3 的唯一剩余窄 P2：**raw Buffer 捕获仍会调用调用方
`valueOf`**。审查反例是普通 `Buffer` 加 own `valueOf`；Node22 的
`Buffer.from(buffer)` 会调用它 1 次，完整入口仍返回 OK。

round4 的修法：

1. `fakes.mjs` 的 `copyBufferBytes()` 不再调用 `Buffer.from(buffer)`，而是用显式
   `new Uint8Array(value)` 按 typed-array 内部 slot 复制字节，再用这份独立
   `ArrayBuffer` 构造 Buffer。该路径不读取实例上的 `length` / `constructor` /
   `valueOf` / `toString` / `buffer` / `byteOffset` 等属性，也不保留调用方 buffer。
2. `raw` 仍只接受 `string` / `Buffer`；普通 Buffer、子类 Buffer 与带 own coercion
   的 Buffer 都按字节复制。Proxy、detached buffer 等无法按 typed-array 读取的输入
   固定 `INVALID_REQUEST fake_executor_raw_type`，不执行回调。
3. 非 Buffer 对象/数字/数组/null/symbol 仍在构造期固定拒绝，不 `String()` /
   `toString()` / `valueOf()`。
4. 其它构造字段、`postconditionOverride` 惰性例外、访问器拒绝、strict success
   postcondition、canonical gate 与产品源码均未改。

`contracts.mjs`、`harness.mjs`、`scenarios.mjs` 与 round3 逐字节相同；`run-harness.mjs`
只改了 usage 中的目录名。round2/round3 的冻结文件均未覆盖。

信任边界不变：这里防的是**同进程受控对象被误替换/误访问器化**，不保证沙箱任意恶意
JS、Proxy 反射陷阱或同进程内刻意破坏。`postcondition` 仍是注入假 adapter 自报，不是
真实 OS 证据；拒绝路径的 `sideEffects=0` 只覆盖本实现实际经过的路径。

## 入口

```sh
# API
import { runProtocolHarness } from "./tests/t13i-protocol-harness/round4/harness.mjs";

# round4 定向自测（只跑 raw 复制边界 6 项）
node --test tests/t13i-protocol-harness/round4/raw-boundary.test.mjs

# 原审查反例（仅 import 路径适配到 round4）
node tests/t13i-protocol-harness/round4/probes/probe-buffer-coercion.mjs
```

`runProtocolHarness(scenario, { lease, executor, probe })` 仍是唯一完整入口。gate 顺序与
round3 相同：scenario 读取走 own data descriptor → `mode=injected` → 拒绝真实执行/引擎
路径 → 拒绝真实 install → 拒绝预算改写 → 只接受私有 WeakMap membership 的冻结 fake →
adapter 容器/方法/postcondition 记录访问器拒绝 → 之后才创建临时目录/调用方法。

## round4 定向验证

- 原审查 `probe-buffer-coercion.mjs`（断言未改，仅 import 路径适配）：`coercionCalls=0`、
  `code=OK`，exit 0。
- `raw-boundary.test.mjs` 6/6：原反例完整入口 0 次 coercion；普通 Buffer 构造后
  caller mutation 与输出隔离；raw 复制不读取结构/coercion getter；Buffer 子类复制；
  非法 raw 固定拒绝且 0 次 coercion；string raw 仍走完整入口。
- 按工单要求**不重跑** round2/round3 的 32 项、canonical 12 场景、strict success
  与旧 27+12；这些范围未改动，仍以上一轮独立验收为准。

不运行真实引擎/clang/ffprobe，不读真实音频/库/凭据，不联网，不安装/解包/下载，
不提交/推送/部署。自测不等于独立验收，也不等于 T13I 第 3 或整体 READY。
